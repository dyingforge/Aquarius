#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { loadLocalEnvFile } from '@aquarius/core';
import { CliError, type ApiClient, resolveClient } from './client.ts';
import { STATUS_GLYPH, createPrinter, heading, printJson, relativeTime, table } from './output.ts';

interface GlobalOptions {
  json?: boolean;
  url?: string;
  token?: string;
}

/** `03:00`-style label for a schedule record. */
function clockLabel(schedule: Record<string, unknown>): string {
  const hour = Number(schedule['hour'] ?? 0);
  const minute = Number(schedule['minute'] ?? 0);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const program = new Command();

program
  .name('aquarius')
  .description('Aquarius — local long-term memory for coding agents. Talks to the local service over HTTP.')
  .version('0.1.0')
  .option('--json', 'print raw JSON instead of formatted text')
  .option('--url <url>', 'service base URL (defaults to the configured host and port)')
  .option('--token <token>', 'local API token (defaults to the config file)');

function globalOptions(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

async function client(): Promise<ApiClient> {
  const options = globalOptions();
  return resolveClient({
    ...(options.url ? { url: options.url } : {}),
    ...(options.token ? { token: options.token } : {}),
  });
}

/** The HEAD a decision must be made against; fetched from the authenticated health view. */
async function currentHead(api: ApiClient): Promise<string | null> {
  const health = await api.get<{ head?: string | null }>('/health');
  return health.head ?? null;
}

/** Asks the user to confirm before an irreversible write. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new CliError(
      'validation_failed',
      'Refusing to apply a write without confirmation in a non-interactive session.',
      'Re-run with --yes once you have reviewed the preview.',
      2,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function output(value: unknown, formatted: (value: never) => void): void {
  const options = globalOptions();
  if (options.json) printJson(value);
  else formatted(value as never);
}

// --- doctor ------------------------------------------------------------------

program
  .command('doctor')
  .description('check the service, database, memory repository, model configuration and authentication')
  .action(async () => {
    const api = await client();
    const report = await api.get<{
      ok: boolean;
      version: string;
      checkedAt: string;
      checks: { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; actionable?: string }[];
    }>('/v1/doctor');

    output(report, (value: typeof report) => {
      const printer = createPrinter(false);
      printer.write(`Aquarius ${value.version} — checked ${value.checkedAt}`);
      for (const check of value.checks) {
        printer.write(`${STATUS_GLYPH[check.status] ?? '?'} ${check.name}: ${check.detail}`);
        if (check.actionable && check.status !== 'ok') printer.write(`    → ${check.actionable}`);
      }
      printer.write(value.ok ? '\nAll required checks passed.' : '\nSome checks failed; see the actions above.');
    });
    if (!report.ok) process.exitCode = 1;
  });

// --- ask ---------------------------------------------------------------------

program
  .command('ask')
  .argument('<question>', 'question to answer from current active memory')
  .option('--limit <n>', 'maximum number of memory candidates to retrieve')
  .description('answer a question using current active memory, with memory IDs cited')
  .action(async (question: string, options: { limit?: string }) => {
    const api = await client();
    const response = await api.post<{
      answer: string;
      memoryIds: string[];
      citations: { memoryId: string; title: string; kind: string; confidence: string; path: string }[];
      uncertainty: string;
      insufficientEvidence: boolean;
      reason: string;
      notices: string[];
      head: string | null;
    }>('/v1/query', {
      question,
      ...(options.limit ? { limit: Number(options.limit) } : {}),
    });

    output(response, (value: typeof response) => {
      const printer = createPrinter(false);
      printer.write(value.answer);
      printer.write(heading('Citations'));
      printer.write(
        value.citations.length === 0
          ? '(no memory was used)'
          : value.citations
              .map((citation) => `- ${citation.memoryId} [${citation.kind}/${citation.confidence}] ${citation.title}`)
              .join('\n'),
      );
      printer.write(
        `\nUncertainty: ${value.uncertainty}${value.insufficientEvidence ? ' (insufficient evidence)' : ''} · head ${value.head?.slice(0, 12) ?? 'unborn'}`,
      );
      if (value.notices.length > 0) printer.write(`Notes:\n${value.notices.map((note) => `- ${note}`).join('\n')}`);
    });
  });

// --- memory ------------------------------------------------------------------

const memory = program.command('memory').description('inspect and correct long-term memory');

memory
  .command('list')
  .option('--kind <kind>', 'experience | profile | strategy | skill')
  .option('--status <status>', 'active | candidate | superseded | forgotten | retired | rejected')
  .option('--limit <n>', 'maximum rows')
  .description('list memories known at Git HEAD')
  .action(async (options: { kind?: string; status?: string; limit?: string }) => {
    const api = await client();
    const response = await api.get<{
      memories: {
        memoryId: string;
        kind: string;
        status: string;
        title: string;
        authority: string;
        confidence: string;
        updatedAt: string | null;
      }[];
      counts: Record<string, number>;
      head: string | null;
    }>(
      `/v1/memories?${new URLSearchParams({
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      }).toString()}`,
    );

    output(response, (value: typeof response) => {
      const printer = createPrinter(false);
      printer.write(
        table(
          value.memories.map((entry) => [
            entry.memoryId,
            entry.kind,
            entry.status,
            entry.authority,
            entry.confidence,
            entry.title.slice(0, 56),
          ]),
          ['id', 'kind', 'status', 'authority', 'conf', 'title'],
        ),
      );
      printer.write(`\ncounts: ${JSON.stringify(value.counts)} · head ${value.head?.slice(0, 12) ?? 'unborn'}`);
    });
  });

memory
  .command('show')
  .argument('<memoryId>')
  .description('show one memory with its provenance and supporting evidence')
  .action(async (memoryId: string) => {
    const api = await client();
    const response = await api.get<Record<string, unknown>>(`/v1/memories/${encodeURIComponent(memoryId)}`);
    output(response, (value: Record<string, unknown>) => {
      const printer = createPrinter(false);
      printer.write(`${String(value['title'])}  [${String(value['kind'])}/${String(value['status'])}]`);
      printer.write(`id: ${String(value['memoryId'])}`);
      printer.write(`path: ${String(value['path'])}`);
      printer.write(
        `authority: ${String(value['authority'])} · confidence: ${String(value['confidence'])} (${String(value['confidenceReason'])})`,
      );
      printer.write(`cases: ${(value['supportingCaseIds'] as string[]).join(', ') || '-'}`);
      printer.write(heading('Body'));
      printer.write(String(value['body']));
      const evidence = value['evidence'] as { evidenceId: string; kind: string; authority: string }[];
      printer.write(heading('Evidence'));
      printer.write(
        evidence.length === 0
          ? '(none recorded)'
          : evidence.map((item) => `- ${item.evidenceId} ${item.kind} (${item.authority})`).join('\n'),
      );
    });
  });

memory
  .command('correct')
  .argument('<instruction>', 'natural-language correction, e.g. "I no longer use pnpm"')
  .option('--yes', 'apply without an interactive prompt')
  .option('--preview-only', 'stop after printing the preview')
  .description('preview a correction, then apply it once confirmed')
  .action(async (instruction: string, options: { yes?: boolean; previewOnly?: boolean }) => {
    const api = await client();
    const preview = await api.post<{
      reviewId: string;
      type: string;
      baseHead: string | null;
      memoryIds: string[];
      diff: string;
      diffStat: string;
      affected: { memoryId: string; change: string; newStatus: string; path: string }[];
      notes: string[];
      expiresAt: string;
    }>('/v1/corrections/preview', { instruction });

    if (globalOptions().json) {
      printJson(preview);
    } else {
      const printer = createPrinter(false);
      printer.write(`Preview ${preview.reviewId} (${preview.type}) against head ${preview.baseHead?.slice(0, 12) ?? 'unborn'}`);
      printer.write(heading('Affected memories'));
      printer.write(
        preview.affected.length === 0
          ? '(no memory affected)'
          : preview.affected.map((entry) => `- ${entry.memoryId} → ${entry.newStatus} (${entry.change}) ${entry.path}`).join('\n'),
      );
      for (const note of preview.notes) printer.write(`note: ${note}`);
      printer.write(heading('Diff'));
      printer.write(preview.diff.trim() === '' ? '(no changes)' : preview.diff);
    }
    if (options.previewOnly) return;

    if (!options.yes) {
      const ok = await confirm('Apply this correction?');
      if (!ok) {
        process.stdout.write('Cancelled; the memory repository was not modified.\n');
        return;
      }
    }

    const applied = await api.post<{ reviewId: string; commitSha: string; memoryIds: string[] }>(
      `/v1/corrections/${encodeURIComponent(preview.reviewId)}/confirm`,
      { expectedHead: preview.baseHead },
    );
    if (globalOptions().json) printJson(applied);
    else process.stdout.write(`Applied correction in ${applied.commitSha.slice(0, 12)} (${applied.memoryIds.join(', ')})\n`);
  });

// --- ingest ------------------------------------------------------------------

const ingest = program.command('ingest').description('ingest agent sessions into memory');

ingest
  .command('run')
  .option('--session <idOrPath>', 'ingest one session by id or file path instead of scanning everything')
  .option('--force', 'process a session even if it still looks like it is being written')
  .description('scan the configured sources and digest new sessions')
  .action(async (options: { session?: string; force?: boolean }) => {
    const api = await client();
    const response = await api.post<{ jobId: string; status: string; result: Record<string, unknown> }>('/v1/ingestions', {
      ...(options.session ? { sessionId: options.session } : {}),
      force: options.force ?? false,
    });
    output(response, (value: typeof response) => {
      const printer = createPrinter(false);
      const stats = (value.result['stats'] ?? {}) as Record<string, unknown>;
      printer.write(`Job ${value.jobId}: ${value.status}`);
      if (Object.keys(stats).length > 0) printer.write(`stats: ${JSON.stringify(stats)}`);
      else printer.write(`result: ${JSON.stringify(value.result)}`);
    });
  });

ingest
  .command('status')
  .description('show scheduler state, session counts and recent jobs')
  .action(async () => {
    const api = await client();
    const response = await api.get<Record<string, never>>('/v1/ingestions/status');
    output(response, (value: Record<string, never>) => {
      const printer = createPrinter(false);
      const schedule = value['schedule'] as unknown as Record<string, unknown>;
      const sessions = value['sessions'] as unknown as Record<string, number>;
      printer.write(`schedule: daily ${clockLabel(schedule)} ${schedule['timeZone']} · next ${schedule['nextRunAt']}`);
      printer.write(`last automatic day: ${String(schedule['lastAutoDay'] ?? 'never')}`);
      printer.write(
        `sessions: ${sessions['total']} total, ${sessions['ingested']} ingested, ${sessions['pending']} pending, ${sessions['deferred']} deferred, ${sessions['failed']} failed`,
      );
      printer.write(`cases: ${String(value['cases'])} · head ${(value['head'] as unknown as string)?.slice(0, 12) ?? 'unborn'}`);
      const jobs = value['recentJobs'] as unknown as Record<string, unknown>[];
      printer.write(heading('Recent jobs'));
      printer.write(
        table(
          jobs.map((job) => [
            String(job['jobId']).slice(0, 14),
            String(job['kind']),
            String(job['trigger']),
            String(job['status']),
            String(job['attempts']),
            String(job['finishedAt'] ?? job['startedAt'] ?? job['createdAt']).slice(0, 19),
          ]),
          ['job', 'kind', 'trigger', 'status', 'tries', 'when'],
        ),
      );
    });
  });

// --- review ------------------------------------------------------------------

const review = program.command('review').description('review conflicting or low-confidence candidates');

review
  .command('list')
  .option('--status <status>', 'pending | preview | applied | rejected | expired')
  .option('--type <type>', 'promotion | conflict | correction | skill_approval | skill_anomaly')
  .description('list open reviews')
  .action(async (options: { status?: string; type?: string }) => {
    const api = await client();
    const response = await api.get<{ reviews: Record<string, unknown>[] }>(
      `/v1/reviews?${new URLSearchParams({
        ...(options.status ? { status: options.status } : {}),
        ...(options.type ? { type: options.type } : {}),
      }).toString()}`,
    );
    output(response, (value: typeof response) => {
      const printer = createPrinter(false);
      printer.write(
        table(
          value.reviews.map((entry) => [
            String(entry['reviewId']),
            String(entry['type']),
            String(entry['status']),
            (entry['memoryIds'] as string[]).join(',').slice(0, 30),
            relativeTime(String(entry['createdAt'])),
          ]),
          ['review', 'type', 'status', 'memories', 'age'],
        ),
      );
    });
  });

review
  .command('show')
  .argument('<reviewId>')
  .description('show a review with its evidence, confidence reason and proposed operations')
  .action(async (reviewId: string) => {
    const api = await client();
    const response = await api.get<Record<string, unknown>>(`/v1/reviews/${encodeURIComponent(reviewId)}`);
    output(response, (value: Record<string, unknown>) => {
      const printer = createPrinter(false);
      printer.write(`${String(value['type'])} review ${String(value['reviewId'])} — ${String(value['status'])}`);
      printer.write(`created: ${String(value['createdAt'])} · base head: ${String(value['baseHead'])?.slice(0, 12)}`);
      const candidate = value['candidate'] as Record<string, unknown> | null;
      const target = value['target'] as Record<string, unknown> | null;
      if (candidate) printer.write(`candidate: ${JSON.stringify(candidate['frontmatter'] ?? candidate).slice(0, 400)}`);
      if (target) printer.write(`target: ${JSON.stringify(target['frontmatter'] ?? target).slice(0, 400)}`);
      printer.write(`confidence reason: ${String(value['confidenceReason'] ?? '-')}`);
      printer.write(heading('Gate reasons'));
      printer.write((value['gateReasons'] as string[]).map((reason) => `- ${reason}`).join('\n') || '-');
      printer.write(heading('Supporting evidence'));
      printer.write(
        (value['supportingEvidence'] as { evidenceId: string; kind: string; snippet: string }[])
          .map((item) => `- ${item.evidenceId} (${item.kind}): ${item.snippet.slice(0, 160)}`)
          .join('\n') || '-',
      );
      printer.write(heading('Contradicting evidence'));
      printer.write(
        (value['contradictingEvidence'] as { evidenceId: string; kind: string; snippet: string }[])
          .map((item) => `- ${item.evidenceId} (${item.kind}): ${item.snippet.slice(0, 160)}`)
          .join('\n') || '-',
      );
    });
  });

review
  .command('resolve')
  .argument('<reviewId>')
  .requiredOption('--decision <decision>', 'adopt | merge | reject | temporal_change | forget')
  .option('--note <text>', 'note recorded with the decision')
  .option('--merged-body <text>', 'merged body when the decision is merge or temporal_change')
  .option('--merged-title <text>', 'merged title when the decision is merge')
  .option('--dry-run', 'print the final diff without applying it')
  .option('--yes', 'apply without an interactive prompt')
  .description('decide a review; the final diff is always shown before anything is written')
  .action(
    async (
      reviewId: string,
      options: { decision: string; note?: string; mergedBody?: string; mergedTitle?: string; dryRun?: boolean; yes?: boolean },
    ) => {
      const api = await client();
      const head = await currentHead(api);
      const payload = {
        decision: options.decision,
        expectedHead: head,
        ...(options.note ? { note: options.note } : {}),
        ...(options.mergedBody ? { mergedBody: options.mergedBody } : {}),
        ...(options.mergedTitle ? { mergedTitle: options.mergedTitle } : {}),
      };

      const preview = await api.post<{ diff: string; diffStat: string; memoryIds: string[]; dryRun: boolean }>(
        `/v1/reviews/${encodeURIComponent(reviewId)}/resolve`,
        { ...payload, dryRun: true },
      );
      if (globalOptions().json && options.dryRun) {
        printJson(preview);
        return;
      }
      if (!globalOptions().json) {
        const printer = createPrinter(false);
        printer.write(`Decision ${options.decision} would change ${preview.memoryIds.join(', ') || '(nothing)'}:`);
        printer.write(preview.diff.trim() === '' ? '(no changes)' : preview.diff);
      }
      if (options.dryRun) return;

      if (!options.yes) {
        const ok = await confirm(`Apply decision "${options.decision}"?`);
        if (!ok) {
          process.stdout.write('Cancelled; nothing was written.\n');
          return;
        }
      }

      const applied = await api.post<{ commitSha: string; memoryIds: string[] }>(
        `/v1/reviews/${encodeURIComponent(reviewId)}/resolve`,
        payload,
      );
      if (globalOptions().json) printJson(applied);
      else process.stdout.write(`Applied in ${applied.commitSha.slice(0, 12)} (${applied.memoryIds.join(', ')})\n`);
    },
  );

// --- index -------------------------------------------------------------------

const index = program.command('index').description('manage the rebuildable search index');

index
  .command('rebuild')
  .description('rebuild the SQLite FTS projection from Git HEAD')
  .action(async () => {
    const api = await client();
    const response = await api.post<{ head: string | null; entries: number; counts: Record<string, number>; parseErrors: string[] }>(
      '/v1/index/rebuild',
    );
    output(response, (value: typeof response) => {
      const printer = createPrinter(false);
      printer.write(`Rebuilt ${value.entries} entries from head ${value.head?.slice(0, 12) ?? 'unborn'}`);
      printer.write(`counts: ${JSON.stringify(value.counts)}`);
      if (value.parseErrors.length > 0) {
        printer.write(`\n${value.parseErrors.length} file(s) failed validation:`);
        for (const error of value.parseErrors.slice(0, 10)) printer.write(`- ${error}`);
      }
    });
  });

// --- skill -------------------------------------------------------------------

const skill = program.command('skill').description('review, publish and roll back declarative skills');

skill
  .command('list')
  .description('list skill candidates, published skills and their install state')
  .action(async () => {
    const api = await client();
    const response = await api.get<{ skills: Record<string, unknown>[] }>('/v1/skills');
    output(response, (value: typeof response) => {
      const printer = createPrinter(false);
      printer.write(
        table(
          value.skills.map((entry) => [
            String(entry['skillId']),
            String(entry['status']),
            String(entry['publication'] ? (entry['publication'] as Record<string, unknown>)['status'] : '-'),
            String(entry['supportingCaseCount']),
            String(entry['purpose']).slice(0, 48),
          ]),
          ['skill', 'memory status', 'install', 'cases', 'purpose'],
        ),
      );
    });
  });

skill
  .command('show')
  .argument('<skillId>')
  .description('show a skill candidate with its install target and name conflicts')
  .action(async (skillId: string) => {
    const api = await client();
    const response = await api.get<Record<string, unknown>>(`/v1/skills/${encodeURIComponent(skillId)}`);
    output(response, (value: Record<string, unknown>) => {
      const printer = createPrinter(false);
      printer.write(`${String(value['name'])} — ${String(value['status'])}`);
      printer.write(`id: ${String(value['skillId'])} · path: ${String(value['path'])}`);
      printer.write(`purpose: ${String(value['purpose'])}`);
      printer.write(`supporting cases: ${String(value['supportingCaseCount'])}`);
      printer.write(`triggers: ${(value['triggers'] as string[]).join(' | ')}`);
      printer.write(`inputs: ${(value['inputs'] as string[]).join(' | ')}`);
      printer.write(`outputs: ${(value['outputs'] as string[]).join(' | ')}`);
      printer.write(heading('Steps'));
      printer.write((value['steps'] as string[]).map((step, index) => `${index + 1}. ${step}`).join('\n'));
      printer.write(heading('Limitations'));
      printer.write((value['limitations'] as string[]).map((item) => `- ${item}`).join('\n'));
      printer.write(`tool dependencies: ${(value['toolDependencies'] as string[]).join(', ') || 'none declared'}`);
      const flags = value['reviewFlags'] as string[];
      if (flags.length > 0) printer.write(`\nquarantine flags: ${flags.join(', ')}`);
      const conflict = value['nameConflict'] as { path: string; managed: boolean } | null;
      const evaluation = value['evaluation'] as { status: string; reportId: string | null; scope: string | null };
      printer.write(`evaluation: ${evaluation.status}${evaluation.reportId ? ` (${evaluation.reportId})` : ''}`);
      if (evaluation.scope) printer.write(`evaluation scope: ${evaluation.scope}`);
      if (conflict) {
        printer.write(
          `\nname conflict at ${conflict.path} (${conflict.managed ? 'managed by Aquarius' : 'NOT managed by Aquarius — publishing will be refused'})`,
        );
      }
    });
  });

skill
  .command('suite-set')
  .argument('<jsonFile>')
  .description('register a versioned, independent release-checklist evaluation suite')
  .action(async (jsonFile: string) => {
    const api = await client();
    const suite = JSON.parse(await readFile(jsonFile, 'utf8')) as Record<string, unknown>;
    const result = await api.post<Record<string, unknown>>('/v1/skills/evaluation-suites', { suite, expectedHead: await currentHead(api) });
    output(result, (value: typeof result) => process.stdout.write(`Registered evaluation suite v${String(value['version'])}.\n`));
  });

skill
  .command('evaluate')
  .argument('<skillId>')
  .description('compare a candidate and its baseline on the registered task suite')
  .action(async (skillId: string) => {
    const api = await client();
    const result = await api.post<Record<string, unknown>>(`/v1/skills/${encodeURIComponent(skillId)}/evaluate`, {});
    output(result, (value: typeof result) => process.stdout.write(`Evaluation ${String(value['status'])}: ${String(value['report_id'])} (${String(value['scope'])}).\n`));
  });

skill
  .command('report')
  .argument('<skillId>')
  .description('show saved evaluation reports for a skill candidate')
  .action(async (skillId: string) => {
    const api = await client();
    const result = await api.get<Record<string, unknown>>(`/v1/skills/${encodeURIComponent(skillId)}/evaluation`);
    output(result, (value: typeof result) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`));
  });

program
  .command('case-outcome')
  .argument('<caseId>')
  .argument('<strategyId>')
  .argument('<attemptId>')
  .argument('<result>', 'success, failure or unknown')
  .requiredOption('--evidence <ids>', 'comma-separated evidence IDs from this case')
  .option('--supersedes <outcomeId>', 'prior outcome ID when correcting a result')
  .description('explicitly confirm the task result for one strategy attempt')
  .action(async (caseId: string, strategyId: string, attemptId: string, result: string, options: { evidence: string; supersedes?: string }) => {
    if (!['success', 'failure', 'unknown'].includes(result)) throw new CliError('validation_failed', 'Result must be success, failure or unknown.', undefined, 2);
    const api = await client();
    const response = await api.post<Record<string, unknown>>(`/v1/cases/${encodeURIComponent(caseId)}/outcomes`, {
      strategyId, attemptId, result,
      evidenceIds: options.evidence.split(',').map((id) => id.trim()).filter(Boolean),
      expectedHead: await currentHead(api), recordedBy: 'local-user',
      ...(options.supersedes ? { supersedes: options.supersedes } : {}),
    });
    output(response, (value: typeof response) => process.stdout.write(`Recorded outcome ${String((value['outcome'] as Record<string, unknown>)?.['outcome_id'])}.\n`));
  });

for (const [command, method, description] of [
  ['approve', 'approve', 'publish and install a skill after explicit approval'],
  ['rollback', 'rollback', 'restore the previously published version'],
  ['retire', 'retire', 'retire a published skill and remove its managed install'],
] as const) {
  skill
    .command(command)
    .argument('<skillId>')
    .option('--yes', 'apply without an interactive prompt')
    .option('--note <text>', 'note recorded with the approval')
    .description(description)
    .action(async (skillId: string, options: { yes?: boolean; note?: string }) => {
      const api = await client();
      const head = await currentHead(api);
      const verb = command === 'approve' ? 'Publish and install' : command === 'rollback' ? 'Roll back' : 'Retire';
      if (!options.yes) {
        const ok = await confirm(`${verb} ${skillId}?`);
        if (!ok) {
          process.stdout.write('Cancelled; nothing was written.\n');
          return;
        }
      }
      const response = await api.post<Record<string, unknown>>(`/v1/skills/${encodeURIComponent(skillId)}/${method}`, {
        expectedHead: head,
        approvedBy: 'local-user',
        requestedBy: 'local-user',
        ...(options.note ? { note: options.note } : {}),
      });
      if (globalOptions().json) printJson(response);
      else process.stdout.write(`${verb.toLowerCase()}ed ${skillId}: ${JSON.stringify(response)}\n`);
    });
}

skill
  .command('reject')
  .argument('<skillId>')
  .option('--reason <text>', 'reason recorded with the rejection')
  .description('reject a skill candidate so it cannot be published')
  .action(async (skillId: string, options: { reason?: string }) => {
    const api = await client();
    const head = await currentHead(api);
    const response = await api.post<Record<string, unknown>>(`/v1/skills/${encodeURIComponent(skillId)}/reject`, {
      expectedHead: head,
      reason: options.reason ?? 'rejected by user',
      resolvedBy: 'local-user',
    });
    if (globalOptions().json) printJson(response);
    else process.stdout.write(`Rejected ${skillId}.\n`);
  });

// --- config ------------------------------------------------------------------

program
  .command('config')
  .description('show the effective configuration (secrets are never printed)')
  .action(async () => {
    const api = await client();
    const response = await api.get<{ config: Record<string, unknown>; issues: unknown[] }>('/v1/config');
    if (globalOptions().json) printJson(response);
    else process.stdout.write(`${JSON.stringify(response.config, null, 2)}\n`);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`aquarius: ${error.message}\n`);
      if (error.actionable) process.stderr.write(`  → ${error.actionable}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const actionable = (error as { actionable?: string }).actionable;
    process.stderr.write(`aquarius: ${message}\n`);
    if (actionable) process.stderr.write(`  → ${actionable}\n`);
    process.exitCode = 1;
  }
}

loadLocalEnvFile();
await main();
