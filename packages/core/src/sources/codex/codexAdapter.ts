import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  NormalizedSession,
  SessionRef,
  SessionSourceAdapter,
  SourceCursor,
} from '../adapter.ts';
import { exists, readTextIfExists } from '../../util/fsx.ts';
import { codexSourceHash, parseCodexSessionLines, toNormalizedSession } from './parse.ts';
import type { SourcePaths } from '../../config.ts';
import { createLogger } from '../../util/logger.ts';

const log = createLogger('adapter:codex');

interface HeadMeta {
  sessionId: string | null;
  parentThreadId: string | null;
  forkedFromId: string | null;
  threadSource: string | null;
  cwd: string | null;
  startedAt: string | null;
}

function parseHead(line: string): HeadMeta {
  const empty: HeadMeta = {
    sessionId: null,
    parentThreadId: null,
    forkedFromId: null,
    threadSource: null,
    cwd: null,
    startedAt: null,
  };
  try {
    const record = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> };
    if (record.type !== 'session_meta' || !record.payload) return empty;
    const payload = record.payload;
    const pick = (key: string): string | null => {
      const value = payload[key];
      return typeof value === 'string' && value !== '' ? value : null;
    };
    return {
      sessionId: pick('session_id') ?? pick('id'),
      parentThreadId: pick('parent_thread_id'),
      forkedFromId: pick('forked_from_id'),
      threadSource: pick('thread_source'),
      cwd: pick('cwd'),
      startedAt: pick('timestamp'),
    };
  } catch {
    return empty;
  }
}

/** Session id fallback derived from a rollout file name: `rollout-<ts>-<uuid>.jsonl`. */
export function sessionIdFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.jsonl$/, '');
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(withoutExtension);
  return match?.[1] ?? withoutExtension;
}

/**
 * Reads only the beginning of a session file. Discovery must stay cheap: a
 * metadata scan must not pull hundreds of megabytes of transcripts into memory.
 */
export async function readFirstLine(file: string, chunkBytes = 128 * 1024): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(chunkBytes);
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    await handle.close();
  }
}

async function* walkJsonl(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(full);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}

export interface CodexAdapterOptions {
  paths: SourcePaths;
}

/**
 * Codex session adapter. Reads activity sessions, archived sessions and the
 * session index; converts all of it into the normalized contract.
 */
export class CodexSessionAdapter implements SessionSourceAdapter {
  readonly source = 'codex';
  readonly schemaVersion = 1;
  #paths: SourcePaths;
  #indexCache: { loadedAt: number; entries: Map<string, { title: string | null; updatedAt: string | null }> } | null =
    null;

  constructor(options: CodexAdapterOptions) {
    this.#paths = options.paths;
  }

  describeSource(): { paths: string[]; available: boolean } {
    return {
      paths: [this.#paths.codexSessionsDir, this.#paths.codexArchivedDir, this.#paths.codexSessionIndex],
      available: true,
    };
  }

  /** Thread titles from `session_index.jsonl`, cached for the lifetime of one scan. */
  async indexEntries(): Promise<Map<string, { title: string | null; updatedAt: string | null }>> {
    const now = Date.now();
    if (this.#indexCache && now - this.#indexCache.loadedAt < 5_000) return this.#indexCache.entries;
    const entries = new Map<string, { title: string | null; updatedAt: string | null }>();
    const text = await readTextIfExists(this.#paths.codexSessionIndex);
    if (text) {
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const record = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
          const id = typeof record.id === 'string' ? record.id : null;
          if (!id) continue;
          entries.set(id, {
            title: typeof record.thread_name === 'string' ? record.thread_name : null,
            updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
          });
        } catch {
          // The index is a mutable external file; malformed lines are ignored.
        }
      }
    }
    this.#indexCache = { loadedAt: now, entries };
    return entries;
  }

  async *discover(cursor?: SourceCursor): AsyncIterable<SessionRef> {
    void cursor; // Incremental decisions use the SQLite checkpoint table, not an adapter cursor.
    const index = await this.indexEntries();
    const seen = new Set<string>();

    for (const [root, archived] of [
      [this.#paths.codexSessionsDir, false],
      [this.#paths.codexArchivedDir, true],
    ] as const) {
      if (!(await exists(root))) continue;
      for await (const file of walkJsonl(root)) {
        const ref = await this.#toRef(file, root, archived, index);
        if (!ref) continue;
        seen.add(`${ref.source}:${ref.sessionId}:${archived ? 'archived' : 'active'}`);
        yield ref;
      }
    }
    log.debug('codex discovery finished', { sessions: seen.size });
  }

  async #toRef(
    file: string,
    root: string,
    archived: boolean,
    index: Map<string, { title: string | null; updatedAt: string | null }>,
  ): Promise<SessionRef | null> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    if (info.size === 0) return null;

    let head: HeadMeta = {
      sessionId: null,
      parentThreadId: null,
      forkedFromId: null,
      threadSource: null,
      cwd: null,
      startedAt: null,
    };
    try {
      head = parseHead(await readFirstLine(file));
    } catch (error) {
      log.debug('cannot read session head', { file: relative(root, file), message: (error as Error).message });
    }

    const fallbackId = sessionIdFromFileName(file.split(sep).pop() ?? file);
    const sessionId = head.sessionId ?? fallbackId;
    const indexEntry = index.get(sessionId);
    return {
      source: this.source,
      sessionId,
      rootThreadId: head.forkedFromId ?? head.parentThreadId ?? sessionId,
      parentThreadId: head.parentThreadId,
      forkedFromId: head.forkedFromId,
      archived,
      path: file,
      threadSource: head.threadSource,
      title: indexEntry?.title ?? null,
      cwd: head.cwd,
      startedAt: head.startedAt,
      updatedAt: (indexEntry?.updatedAt ?? info.mtime.toISOString()),
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    };
  }

  async read(ref: SessionRef): Promise<NormalizedSession> {
    const raw = await readFile(ref.path, 'utf8');
    const parsed = parseCodexSessionLines(raw);
    const index = await this.indexEntries();
    return toNormalizedSession({
      parsed,
      sourceHash: codexSourceHash(raw),
      path: ref.path,
      archived: ref.archived,
      fallbackSessionId: ref.sessionId,
      title: ref.title ?? index.get(ref.sessionId)?.title ?? null,
      byteLength: Buffer.byteLength(raw, 'utf8'),
    });
  }
}
