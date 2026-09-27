import { join, posix } from 'node:path';
import { chmod } from 'node:fs/promises';
import { AquariusError, StaleHeadError } from '../errors.ts';
import { ensureDir, exists, withTempDir } from '../util/fsx.ts';
import { EMPTY_TREE_SHA, GitCommandError, runGit } from './git.ts';
import { REPO_README, TREE_DIRECTORIES, SUMMARY_FILES, repoReadme } from '../memory/paths.ts';
import { nowIso } from '../util/time.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('memory-store');

export interface FileChange {
  /** Repository-relative POSIX path. */
  path: string;
  /** New content, or null to delete the file. */
  content: string | null;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'unchanged';

export interface ChangeSummary {
  path: string;
  status: ChangeStatus;
}

export interface ProposedTree {
  baseHead: string | null;
  /** Tree object written into the object database; the working tree is untouched. */
  treeSha: string;
  /** Dangling commit object used only to render a reviewable diff. */
  commitSha: string;
  /** Unified diff suitable for display to the user. */
  diff: string;
  diffStat: string;
  files: ChangeSummary[];
  message: string;
}

export interface CommitTrailers {
  jobId?: string;
  sessionId?: string;
  sourceHash?: string;
  kind: string;
}

export interface CommitResult {
  commitSha: string;
  previousHead: string | null;
  diff: string;
  diffStat: string;
  files: ChangeSummary[];
}

export interface CommitInfo {
  sha: string;
  subject: string;
  body: string;
  authorDate: string;
  trailers: Record<string, string>;
}

export interface MemoryStoreOptions {
  authorName?: string;
  authorEmail?: string;
}

const ALLOWED_PREFIXES = [
  'summary/',
  'active/',
  'candidates/',
  'archive/',
  'evidence/',
  'outcomes/',
  'evaluations/',
  'reviews/',
  'skills/',
  'audit/',
];

/** Validates that a change path stays inside the memory tree. */
export function assertSafeMemoryPath(path: string): void {
  if (path.length === 0) throw new AquariusError('validation_failed', 'Empty memory path');
  if (path.startsWith('/') || path.includes('\\')) {
    throw new AquariusError('validation_failed', `Illegal memory path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new AquariusError('validation_failed', `Memory path escapes the repository tree: ${path}`);
  }
  if (path === REPO_README) return;
  if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new AquariusError('validation_failed', `Memory path is outside the documented tree layout: ${path}`, {
      actionable: `Only ${ALLOWED_PREFIXES.join(', ')} may be written by Aquarius.`,
    });
  }
}

export function formatCommitMessage(subject: string, body: string | undefined, trailers: CommitTrailers): string {
  const lines: string[] = [subject, ''];
  if (body && body.trim() !== '') {
    lines.push(body.trim(), '');
  }
  if (trailers.jobId) lines.push(`Aquarius-Job: ${trailers.jobId}`);
  if (trailers.sessionId) lines.push(`Aquarius-Session: ${trailers.sessionId}`);
  if (trailers.sourceHash) lines.push(`Aquarius-Source-Hash: ${trailers.sourceHash}`);
  lines.push(`Aquarius-Kind: ${trailers.kind}`, '');
  return lines.join('\n');
}

export function parseCommitTrailers(message: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of message.split('\n')) {
    const match = /^Aquarius-([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (match && match[1] && match[2]) trailers[match[1].toLowerCase()] = match[2].trim();
  }
  return trailers;
}

/**
 * The canonical memory repository.
 *
 * All writes go through {@link propose} + {@link commit}:
 *  - the proposed tree is built in an isolated index (never the working tree);
 *  - commit creation is compare-and-swap on the branch ref, so a proposal built
 *    against an older HEAD can never be applied;
 *  - the working tree is only updated after the ref moved.
 */
export class MemoryStore {
  readonly repoPath: string;
  #authorName: string;
  #authorEmail: string;

  constructor(repoPath: string, options: MemoryStoreOptions = {}) {
    this.repoPath = repoPath;
    this.#authorName = options.authorName ?? 'Aquarius';
    this.#authorEmail = options.authorEmail ?? 'aquarius@localhost';
  }

  private env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      GIT_AUTHOR_NAME: this.#authorName,
      GIT_AUTHOR_EMAIL: this.#authorEmail,
      GIT_COMMITTER_NAME: this.#authorName,
      GIT_COMMITTER_EMAIL: this.#authorEmail,
      ...extra,
    };
  }

  async isGitRepository(): Promise<boolean> {
    if (!(await exists(join(this.repoPath, '.git')))) return false;
    const result = await runGit(['rev-parse', '--is-inside-work-tree'], {
      cwd: this.repoPath,
      allowFailure: true,
    });
    return result.code === 0 && result.stdout.trim() === 'true';
  }

  async assertUsableRepository(): Promise<void> {
    if (!(await exists(this.repoPath))) {
      throw new AquariusError('memory_repo_invalid', `Memory repository ${this.repoPath} does not exist.`, {
        actionable: 'Run the Aquarius service once to initialize it, or point AQUARIUS_MEMORY_REPO at a Git repository.',
      });
    }
    if (!(await this.isGitRepository())) {
      throw new AquariusError('memory_repo_invalid', `Memory repository ${this.repoPath} is not a Git repository.`, {
        actionable: 'Initialize it with `git init` or point AQUARIUS_MEMORY_REPO at an existing repository.',
      });
    }
  }

  /**
   * Creates the repository and its documented directory skeleton if needed.
   * Returns true when a repository was created by this call.
   *
   * A directory that already holds files but is not a Git repository is refused:
   * Aquarius never initializes over someone else's data.
   */
  async ensureInitialized(): Promise<boolean> {
    await ensureDir(this.repoPath, 0o700);
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(this.repoPath);
      if (entries.length > 0) {
        throw new AquariusError(
          'memory_repo_invalid',
          `${this.repoPath} is not a Git repository and is not empty (${entries.slice(0, 5).join(', ')}).`,
          {
            actionable:
              'Point AQUARIUS_MEMORY_REPO at an empty directory or an existing Git repository. Nothing was modified.',
            details: { entries: entries.slice(0, 20) },
          },
        );
      }
      await runGit(['init', '--initial-branch=main', '--quiet'], { cwd: this.repoPath, env: this.env() });
      await runGit(['config', 'core.autocrlf', 'false'], { cwd: this.repoPath, allowFailure: true });
      await runGit(['config', 'commit.gpgsign', 'false'], { cwd: this.repoPath, allowFailure: true });
    }
    const created = !isRepo;

    const hasCommit = (await this.head()) !== null;
    const keepFiles = TREE_DIRECTORIES.map((dir) => ({ path: `${dir}/.gitkeep`, content: '' }));
    const seed: FileChange[] = [
      { path: REPO_README, content: repoReadme() },
      { path: SUMMARY_FILES.memory, content: '# Aquarius memory summary\n\nNo memories yet.\n' },
      { path: SUMMARY_FILES.profile, content: '# Profile\n\nNo active profile entries yet.\n' },
      { path: SUMMARY_FILES.strategies, content: '# Strategies\n\nNo active strategies yet.\n' },
    ];
    const missingKeep: FileChange[] = [];
    for (const file of keepFiles) {
      if (!(await exists(join(this.repoPath, file.path)))) missingKeep.push(file);
    }
    if (!hasCommit) {
      await this.commit([...seed, ...missingKeep], {
        expectedHead: null,
        subject: created ? 'Initialize Aquarius memory repository' : 'Initialize Aquarius memory tree',
        trailers: { kind: 'bootstrap' },
      });
      return true;
    }
    if (missingKeep.length > 0) {
      await this.commit(missingKeep, {
        expectedHead: await this.head(),
        subject: 'Add missing memory directories',
        trailers: { kind: 'bootstrap' },
      });
    }
    return created;
  }

  async head(): Promise<string | null> {
    const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: this.repoPath,
      allowFailure: true,
    });
    if (result.code !== 0) return null;
    const sha = result.stdout.trim();
    return sha === '' ? null : sha;
  }

  async branch(): Promise<string> {
    const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.repoPath, allowFailure: true });
    const name = result.stdout.trim();
    return result.code === 0 && name !== '' && name !== 'HEAD' ? name : 'main';
  }

  /** Uncommitted changes in the working tree. Aquarius never discards user edits. */
  async dirtyPaths(): Promise<string[]> {
    const result = await runGit(['status', '--porcelain', '--untracked-files=all'], { cwd: this.repoPath });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  async listTreeFiles(sha?: string): Promise<string[]> {
    const target = sha ?? 'HEAD';
    const result = await runGit(['ls-tree', '-r', '--name-only', target], { cwd: this.repoPath });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  async readFile(path: string, sha?: string): Promise<string | null> {
    assertSafeMemoryPath(path);
    const result = await runGit(['show', `${sha ?? 'HEAD'}:${path}`], { cwd: this.repoPath, allowFailure: true });
    if (result.code !== 0) return null;
    return result.stdout;
  }

  async readWorkingFile(path: string): Promise<string | null> {
    const { readTextIfExists } = await import('../util/fsx.ts');
    return readTextIfExists(join(this.repoPath, path));
  }

  /**
   * Builds a candidate commit object without moving any ref, and renders the
   * exact diff the user would be approving. Used by every preview flow.
   */
  async propose(
    changes: FileChange[],
    options: { expectedHead?: string | null; subject?: string; body?: string; trailers?: CommitTrailers } = {},
  ): Promise<ProposedTree> {
    for (const change of changes) assertSafeMemoryPath(change.path);
    const baseHead = await this.head();
    if (options.expectedHead !== undefined && options.expectedHead !== baseHead) {
      throw new StaleHeadError(options.expectedHead, baseHead);
    }

    return withTempDir('aquarius-stage-', async (tempDir) => {
      const indexPath = join(tempDir, 'index');
      const indexEnv = { GIT_INDEX_FILE: indexPath };
      await runGit(baseHead ? ['read-tree', baseHead] : ['read-tree', '--empty'], {
        cwd: this.repoPath,
        env: { ...this.env(), ...indexEnv },
      });

      for (const change of changes) {
        if (change.content === null) {
          await runGit(['update-index', '--force-remove', '--', change.path], {
            cwd: this.repoPath,
            env: { ...this.env(), ...indexEnv },
            allowFailure: true,
          });
          continue;
        }
        const blob = await runGit(['hash-object', '-w', '--stdin'], {
          cwd: this.repoPath,
          env: this.env(),
          input: change.content,
        });
        const blobSha = blob.stdout.trim();
        await runGit(['update-index', '--add', '--cacheinfo', `100644,${blobSha},${change.path}`], {
          cwd: this.repoPath,
          env: { ...this.env(), ...indexEnv },
        });
      }

      const tree = await runGit(['write-tree'], { cwd: this.repoPath, env: { ...this.env(), ...indexEnv } });
      const treeSha = tree.stdout.trim();

      const message = formatCommitMessage(
        options.subject ?? 'Proposed memory change',
        options.body,
        options.trailers ?? { kind: 'proposal' },
      );
      const commitArgs = ['commit-tree', treeSha];
      if (baseHead) commitArgs.push('-p', baseHead);
      commitArgs.push('-F', '-');
      const commit = await runGit(commitArgs, { cwd: this.repoPath, env: this.env(), input: message });
      const commitSha = commit.stdout.trim();

      const { diff, diffStat, files } = await this.describeDiff(baseHead, treeSha);
      return { baseHead, treeSha, commitSha, diff, diffStat, files, message };
    });
  }

  /** Unified diff + per-file status between two trees (or a tree and the empty tree). */
  async describeDiff(baseHead: string | null, treeSha: string): Promise<{
    diff: string;
    diffStat: string;
    files: ChangeSummary[];
  }> {
    const left = baseHead ?? EMPTY_TREE_SHA;
    // `-r` is required: without it diff-tree reports only top-level entries and
    // every change below the first directory level is invisible.
    const diff = await runGit(['diff-tree', '-r', '-p', '--no-color', '--no-commit-id', left, treeSha], {
      cwd: this.repoPath,
      maxBufferBytes: 16 * 1024 * 1024,
    });
    const stat = await runGit(['diff-tree', '-r', '--stat', '--no-color', '--no-commit-id', left, treeSha], {
      cwd: this.repoPath,
    });
    const nameStatus = await runGit(['diff-tree', '-r', '--name-status', '--no-commit-id', left, treeSha], {
      cwd: this.repoPath,
    });
    const files: ChangeSummary[] = nameStatus.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const [statusCode, ...rest] = line.split(/\s+/);
        const path = rest.join(' ');
        const status: ChangeStatus =
          statusCode === 'A'
            ? 'added'
            : statusCode === 'D'
              ? 'deleted'
              : statusCode === 'M'
                ? 'modified'
                : 'unchanged';
        return { path, status };
      });
    return { diff: diff.stdout, diffStat: stat.stdout.trimEnd(), files };
  }

  /**
   * Applies changes atomically: the branch ref only moves if it still points at
   * the HEAD the proposal was built from, then the working tree is synchronized.
   */
  async commit(
    changes: FileChange[],
    options: {
      expectedHead?: string | null;
      subject: string;
      body?: string;
      trailers?: CommitTrailers;
      /** Skip the dirty check (used for the very first commit in a fresh directory). */
      allowDirty?: boolean;
    },
  ): Promise<CommitResult> {
    await this.assertUsableRepository();
    const proposal = await this.propose(changes, {
      ...(options.expectedHead !== undefined ? { expectedHead: options.expectedHead } : {}),
      subject: options.subject,
      ...(options.body !== undefined ? { body: options.body } : {}),
      trailers: options.trailers ?? { kind: 'memory-write' },
    });

    if (!options.allowDirty) {
      const dirty = await this.dirtyPaths();
      if (dirty.length > 0) {
        throw new AquariusError(
          'memory_repo_dirty',
          `The memory repository has uncommitted local changes (${dirty.slice(0, 5).join(', ')}).`,
          {
            actionable:
              'Commit, stash or discard those changes first. Aquarius never overwrites a working tree it did not write.',
            details: { dirty: dirty.slice(0, 20) },
          },
        );
      }
    }

    const branch = await this.branch();
    const zero = '0000000000000000000000000000000000000000';
    const cas = await runGit(['update-ref', `refs/heads/${branch}`, proposal.commitSha, proposal.baseHead ?? zero], {
      cwd: this.repoPath,
      env: this.env(),
      allowFailure: true,
    });
    if (cas.code !== 0) {
      const currentHead = await this.head();
      throw new StaleHeadError(proposal.baseHead, currentHead);
    }

    await runGit(['reset', '--hard', proposal.commitSha], { cwd: this.repoPath, env: this.env() });
    log.info('committed memory change', {
      commit: proposal.commitSha.slice(0, 12),
      files: proposal.files.length,
      kind: options.trailers?.kind ?? 'memory-write',
    });

    return {
      commitSha: proposal.commitSha,
      previousHead: proposal.baseHead,
      diff: proposal.diff,
      diffStat: proposal.diffStat,
      files: proposal.files,
    };
  }

  async log(options: { limit?: number; since?: string } = {}): Promise<CommitInfo[]> {
    // %x00 separates fields and %x1e separates records: a commit body legitimately
    // contains newlines, so splitting on them would corrupt multi-line messages.
    // They are written as git escapes because execFile args cannot hold NUL bytes.
    const FIELD = '\u0000';
    const RECORD = '\u001e';
    const args = ['log', `--max-count=${options.limit ?? 50}`, '--format=%H%x00%s%x00%b%x00%aI%x1e'];
    if (options.since) args.push(`--since=${options.since}`);
    const result = await runGit(args, { cwd: this.repoPath, allowFailure: true });
    if (result.code !== 0) return [];
    return result.stdout
      .split(RECORD)
      .map((record) => record.replace(/^\n/, ''))
      .filter((record) => record.trim() !== '')
      .map((record) => {
        const [sha, subject, body, authorDate] = record.split(FIELD);
        return {
          sha: sha ?? '',
          subject: subject ?? '',
          body: body ?? '',
          authorDate: authorDate ?? '',
          trailers: parseCommitTrailers(body ?? ''),
        };
      })
      .filter((entry) => entry.sha !== '');
  }

  async listAquariusCommits(limit = 200): Promise<CommitInfo[]> {
    const commits = await this.log({ limit });
    return commits.filter((commit) => commit.trailers['job'] !== undefined || commit.trailers['kind'] !== undefined);
  }

  /** Parent chain of a path, newest first. Used for skill rollback. */
  async fileHistory(path: string, limit = 20): Promise<string[]> {
    assertSafeMemoryPath(path);
    const result = await runGit(['log', `--max-count=${limit}`, '--format=%H', '--', path], {
      cwd: this.repoPath,
      allowFailure: true,
    });
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  async repositoryStats(): Promise<{ head: string | null; commits: number; files: number; branch: string }> {
    const head = await this.head();
    const commits = await runGit(['rev-list', '--count', 'HEAD'], { cwd: this.repoPath, allowFailure: true });
    const files = head ? (await this.listTreeFiles()).length : 0;
    return {
      head,
      commits: commits.code === 0 ? Number(commits.stdout.trim() || '0') : 0,
      files,
      branch: await this.branch(),
    };
  }

  /** Restricts file permissions on the repository root (memory can contain personal data). */
  async tightenPermissions(): Promise<void> {
    try {
      await chmod(this.repoPath, 0o700);
    } catch {
      // Best effort: not all filesystems support POSIX modes.
    }
  }

  static isGitError(error: unknown): error is GitCommandError {
    return error instanceof GitCommandError;
  }

  static now(): string {
    return nowIso();
  }
}
