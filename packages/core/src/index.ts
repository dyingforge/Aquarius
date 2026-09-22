/**
 * @aquarius/core — public surface.
 *
 * Everything the server and CLI need. Anything not exported here is an internal
 * detail and may change.
 */

export {
  SERVICE_VERSION,
  loadConfig,
  requireUsableConfig,
  assertMemoryRepoUsable,
  sanitizeConfigForOutput,
  APP_REPO_ROOT,
  type AquariusConfig,
  type AgentBudgets,
  type ConfigIssue,
  type LoadedConfig,
  type ScheduleConfig,
  type SourcePaths,
} from './config.ts';

export { AquariusError, StaleHeadError, isAquariusError, type AquariusErrorCode } from './errors.ts';

export { configureLogging, createLogger, type LogLevel, type Logger } from './util/logger.ts';
export { createRedactor, Redactor, type RedactionFinding, type RedactionResult } from './security/redact.ts';
export { sanitizeSession, extractEvidence, assertNoSecrets } from './security/sanitizeSession.ts';
export { AsyncMutex } from './util/mutex.ts';
export { ensureDir, exists, readTextIfExists, sha256, sha256OfFile, truncate, writeFileAtomic } from './util/fsx.ts';
export { deriveId, isUlid, newEvidenceId, newMemoryId, slugify, ulid } from './util/ids.ts';
export {
  DEFAULT_TIME_ZONE,
  dayKey,
  instantAtZonedTime,
  lastDailyRun,
  minutesFromNow,
  monthKey,
  nextDailyRun,
  nowIso,
  yearKey,
  zonedClock,
  zoneOffsetMs,
} from './util/time.ts';

export { AquariusDatabase, migrate, openAndMigrate, LATEST_SCHEMA_VERSION } from './db/database.ts';
export { SessionStore, type CaseRecord, type SessionRecord, type SessionStatus } from './db/sessionStore.ts';
export { JobStore, JOB_PRIORITY, type JobKind, type JobRecord, type JobStatus, type JobTrigger } from './db/jobStore.ts';
export { ReviewStore, type ReviewRecord, type ReviewStatus, type ReviewType } from './db/reviewStore.ts';
export { ProjectionStore, makeSnippet, type MemorySearchHit, type SkillPublicationRecord } from './db/projectionStore.ts';
export { CommitStore, type GitCommitRecord } from './db/commitStore.ts';

export {
  ACTIVE_STATUS,
  AUTHORITIES,
  CONFIDENCES,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  SCHEMA_VERSION,
  SENSITIVITIES,
  evidenceFrontmatterSchema,
  memoryFrontmatterSchema,
  skillSpecSchema,
  type EvidenceFrontmatter,
  type MemoryFrontmatter,
  type MemoryRecord,
} from './memory/schema.ts';
export {
  parseMemory,
  serializeEvidence,
  serializeMemory,
  splitFrontmatter,
  tryParseEvidence,
  tryParseMemory,
} from './memory/frontmatter.ts';
export {
  QUERY_READABLE_PREFIXES,
  SUMMARY_FILES,
  TREE_DIRECTORIES,
  auditPath,
  evidencePath,
  isActivePath,
  isQueryReadablePath,
  memoryPath,
  reviewPath,
  skillPath,
} from './memory/paths.ts';
export { MemoryRepository, serializeRecord, summaryFilePaths, type MemorySnapshot } from './memory/repository.ts';
export { buildSummary, type SummaryBundle } from './memory/summary.ts';

export {
  MemoryStore,
  assertSafeMemoryPath,
  formatCommitMessage,
  parseCommitTrailers,
  type ChangeSummary,
  type CommitResult,
  type FileChange,
  type ProposedTree,
} from './git/memoryStore.ts';
export { EMPTY_TREE_SHA, GitCommandError, gitVersion, runGit } from './git/git.ts';

export { AdapterRegistry } from './sources/registry.ts';
export { CodexSessionAdapter, sessionIdFromFileName, readFirstLine } from './sources/codex/codexAdapter.ts';
export {
  CODEX_ADAPTER_NAME,
  CODEX_SCHEMA_VERSION,
  isInjectedUserMessage,
  parseCodexSessionLines,
  toolOutputLooksFailed,
} from './sources/codex/parse.ts';
export type {
  NormalizedMessage,
  NormalizedSession,
  NormalizedToolResult,
  SanitizedSession,
  SessionRef,
  SessionSourceAdapter,
  SourceCursor,
} from './sources/adapter.ts';

export {
  PROMOTION_RULES,
  applyPromotionGate,
  applySkillGate,
  assertExpectedHead,
  verifyAuthority,
  type GateDecision,
  type PromotionGateContext,
  type SkillGateDecision,
} from './gates/promotion.ts';

export type {
  ConsolidationOperation,
  ConsolidatorOutput,
  EvidenceCandidate,
  ExtractorOutput,
  LoadedMemory,
  Observation,
  QueryOutput,
  RelatedMemory,
  SelectionOutput,
  SkillDraft,
} from './agents/contracts.ts';
export {
  BudgetedAgentRuntime,
  type AgentRunMetric,
  type AgentRuntime,
  type AgentRuntimeDescription,
} from './agents/runtime.ts';
export { FakeAgentRuntime } from './agents/fakeRuntime.ts';
export {
  MEMORY_CONSOLIDATOR_INSTRUCTIONS,
  MEMORY_EXTRACTOR_INSTRUCTIONS,
  MEMORY_QUERY_INSTRUCTIONS,
  SKILL_SYNTHESIZER_INSTRUCTIONS,
  UNTRUSTED_DATA_NOTICE,
} from './agents/prompts.ts';

export { buildMatchQuery, augmentForIndex, lexicalOverlap, tokenizeForFts } from './query/ftsText.ts';
export {
  RetrievalService,
  projectFromGit,
  toIndexEntry,
  toRelatedMemory,
  type QueryResponse,
  type IndexRebuildReport,
} from './query/retrieval.ts';

export { IngestService, type BatchIngestResult, type IngestStats, type SessionIngestResult } from './pipeline/ingest.ts';
export {
  CorrectionService,
  classifyCorrection,
  type CorrectionConfirmation,
  type CorrectionPreview,
  type CorrectionType,
} from './corrections/service.ts';
export { ReviewService, type ReviewDecision, type ReviewResolution, type ReviewView } from './reviews/service.ts';
export {
  AQUARIUS_SKILL_MARKER,
  SkillService,
  validateSkillCandidate,
  type SkillCandidateView,
  type SkillValidationResult,
} from './skills/service.ts';

export { JobQueue, type JobHandler } from './jobs/queue.ts';
export { Scheduler, type ScheduleDecision } from './jobs/scheduler.ts';
export { reconcileFromGit, type ReconcileReport } from './jobs/reconcile.ts';

export {
  AquariusService,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  type HealthReport,
  type ServiceOptions,
} from './service.ts';
