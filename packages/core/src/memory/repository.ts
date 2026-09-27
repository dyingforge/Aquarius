import type { MemoryStore, FileChange } from '../git/memoryStore.ts';
import { serializeMemory, tryParseEvidence, tryParseMemory } from './frontmatter.ts';
import type { EvidenceFrontmatter, MemoryRecord } from './schema.ts';
import { memoryPath, SUMMARY_FILES } from './paths.ts';
import { sha256 } from '../util/fsx.ts';
import { createLogger } from '../util/logger.ts';
import { DEFAULT_TIME_ZONE } from '../util/time.ts';
import { caseOutcomeSchema, type CaseOutcome } from '../gates/caseOutcome.ts';
import { evaluationReportSchema, evaluationSuiteSchema, type EvaluationReport, type EvaluationSuite } from '../skills/evaluation.ts';

const log = createLogger('memory:repository');

export interface StoredEvidenceFile {
  frontmatter: EvidenceFrontmatter;
  body: string;
  path: string;
}

export interface MemorySnapshot {
  head: string | null;
  records: MemoryRecord[];
  byId: Map<string, MemoryRecord>;
  evidence: StoredEvidenceFile[];
  evidenceByCase: Map<string, StoredEvidenceFile[]>;
  outcomes: CaseOutcome[];
  evaluationSuites: EvaluationSuite[];
  evaluationReports: EvaluationReport[];
  parseErrors: string[];
  files: string[];
  fileHashes: Map<string, string>;
}

/**
 * Read model over the memory Git repository. The repository is the source of
 * truth; this class only reads a commit and turns it into validated records.
 * Anything unreadable is reported, never silently ignored.
 */
export class MemoryRepository {
  #store: MemoryStore;
  #timeZone: string;

  constructor(store: MemoryStore, options: { timeZone?: string } = {}) {
    this.#store = store;
    this.#timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  }

  get store(): MemoryStore {
    return this.#store;
  }

  async head(): Promise<string | null> {
    return this.#store.head();
  }

  /** Loads every memory and evidence file at `head` (defaults to HEAD). */
  async snapshot(head?: string | null): Promise<MemorySnapshot> {
    const resolvedHead = head === undefined ? await this.#store.head() : head;
    const files = resolvedHead === null ? [] : await this.#store.listTreeFiles(resolvedHead ?? undefined);
    const records: MemoryRecord[] = [];
    const evidence: StoredEvidenceFile[] = [];
    const evidenceByCase = new Map<string, StoredEvidenceFile[]>();
    const outcomes: CaseOutcome[] = [];
    const evaluationSuites: EvaluationSuite[] = [];
    const evaluationReports: EvaluationReport[] = [];
    const parseErrors: string[] = [];
    const fileHashes = new Map<string, string>();

    for (const file of files) {
      if (file.startsWith('evaluations/') && file.endsWith('.json')) {
        const content = await this.#store.readFile(file, resolvedHead ?? undefined);
        if (content !== null) fileHashes.set(file, sha256(content));
        try {
          if (file.startsWith('evaluations/suites/')) {
            const parsed = evaluationSuiteSchema.parse(JSON.parse(content ?? 'null'));
            if (file !== `evaluations/suites/${parsed.strategy_id}.json`) throw new Error('path does not match strategy ID');
            evaluationSuites.push(parsed);
          } else if (file.startsWith('evaluations/reports/')) {
            const parsed = evaluationReportSchema.parse(JSON.parse(content ?? 'null'));
            if (file !== `evaluations/reports/${parsed.report_id}.json`) throw new Error('path does not match report ID');
            evaluationReports.push(parsed);
          } else throw new Error('unknown evaluation file');
        } catch (error) {
          parseErrors.push(`${file}: invalid evaluation (${(error as Error).message})`);
        }
        continue;
      }
      if (file.startsWith('outcomes/') && file.endsWith('.json')) {
        const content = await this.#store.readFile(file, resolvedHead ?? undefined);
        if (content !== null) fileHashes.set(file, sha256(content));
        try {
          const parsed = caseOutcomeSchema.parse(JSON.parse(content ?? 'null'));
          if (file !== `outcomes/${parsed.case_id}/${parsed.outcome_id}.json`) throw new Error('path does not match outcome IDs');
          outcomes.push(parsed);
        } catch (error) {
          parseErrors.push(`${file}: invalid case outcome (${(error as Error).message})`);
        }
        continue;
      }
      if (!file.endsWith('.md')) continue;
      if (file.startsWith('summary/') || file.startsWith('audit/') || file.startsWith('reviews/')) continue;
      const content = await this.#store.readFile(file, resolvedHead ?? undefined);
      if (content === null) continue;
      fileHashes.set(file, sha256(content));

      if (file.startsWith('evidence/')) {
        const parsed = tryParseEvidence(content, file);
        if (!parsed.ok || !parsed.value) {
          parseErrors.push(...parsed.errors);
          continue;
        }
        const entry: StoredEvidenceFile = {
          frontmatter: parsed.value.frontmatter,
          body: parsed.value.body,
          path: file,
        };
        evidence.push(entry);
        const list = evidenceByCase.get(entry.frontmatter.case_id) ?? [];
        list.push(entry);
        evidenceByCase.set(entry.frontmatter.case_id, list);
        continue;
      }

      if (!file.startsWith('active/') && !file.startsWith('candidates/') && !file.startsWith('archive/') && !file.startsWith('skills/')) {
        continue;
      }
      const parsed = tryParseMemory(content, file);
      if (!parsed.ok || !parsed.value) {
        parseErrors.push(...parsed.errors);
        continue;
      }
      records.push(parsed.value);
    }

    if (parseErrors.length > 0) log.warn('memory files failed validation', { count: parseErrors.length });

    const byId = new Map<string, MemoryRecord>();
    for (const record of records) byId.set(record.frontmatter.id, record);

    return { head: resolvedHead, records, byId, evidence, evidenceByCase, outcomes, evaluationSuites, evaluationReports, parseErrors, files, fileHashes };
  }

  async activeRecords(head?: string | null): Promise<MemoryRecord[]> {
    const snapshot = await this.snapshot(head);
    return snapshot.records.filter((record) => record.frontmatter.status === 'active');
  }

  async readSummaryFile(name: keyof typeof SUMMARY_FILES, head?: string | null): Promise<string> {
    const content = await this.#store.readFile(SUMMARY_FILES[name], head ?? undefined);
    return content ?? '';
  }

  async readFile(path: string, head?: string | null): Promise<string | null> {
    return this.#store.readFile(path, head ?? undefined);
  }

  /**
   * Validates and stages a set of record writes.
   *
   * Path changes are handled explicitly: when a record moves between status
   * buckets (for example active → archive on supersede) the old file is deleted
   * in the same commit so the tree never contains two copies of one memory.
   */
  planRecordWrites(input: {
    snapshot: MemorySnapshot;
    upserts: { record: MemoryRecord }[];
    deletions?: { path: string }[];
  }): { changes: FileChange[]; records: MemoryRecord[] } {
    const changes = new Map<string, FileChange>();
    const finalRecords = new Map<string, MemoryRecord>();
    for (const record of input.snapshot.records) finalRecords.set(record.frontmatter.id, record);

    for (const upsert of input.upserts) {
      const record = upsert.record;
      const targetPath = memoryPath(record.frontmatter, this.#timeZone);
      const previous = input.snapshot.byId.get(record.frontmatter.id);
      if (previous && previous.path !== targetPath) {
        changes.set(previous.path, { path: previous.path, content: null });
      }
      changes.set(targetPath, { path: targetPath, content: serializeRecord(record) });
      finalRecords.set(record.frontmatter.id, { ...record, path: targetPath });
    }

    for (const deletion of input.deletions ?? []) {
      changes.set(deletion.path, { path: deletion.path, content: null });
      for (const [id, record] of finalRecords) {
        if (record.path === deletion.path) finalRecords.delete(id);
      }
    }

    return { changes: [...changes.values()], records: [...finalRecords.values()] };
  }

  /** Content hash used to detect whether a memory file actually changed. */
  static recordHash(record: MemoryRecord): string {
    return sha256(serializeRecord(record));
  }
}

export function serializeRecord(record: { frontmatter: MemoryRecord['frontmatter']; body: string }): string {
  return serializeMemory(record);
}

export function summaryFilePaths(): string[] {
  return Object.values(SUMMARY_FILES);
}
