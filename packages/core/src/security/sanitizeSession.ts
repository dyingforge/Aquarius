import type { NormalizedSession, SanitizedSession } from '../sources/adapter.ts';
import type { RedactionFinding, Redactor } from './redact.ts';
import type { EvidenceCandidate } from '../agents/contracts.ts';

/**
 * Pre-model sanitization.
 *
 * Deterministic redaction runs here — before any model call, before any log line
 * and before any Git write. Only redacted evidence fragments are ever persisted;
 * complete sessions are never copied into the memory repository.
 */

const MAX_SNIPPET_CHARS = 1200;
const MAX_EVIDENCE_PER_KIND = 40;

export interface SanitizedSessionResult {
  session: SanitizedSession;
  findings: RedactionFinding[];
}

export function sanitizeSession(session: NormalizedSession, redactor: Redactor): SanitizedSessionResult {
  const findings = new Map<string, number>();
  const bump = (list: RedactionFinding[]): void => {
    for (const finding of list) findings.set(finding.rule, (findings.get(finding.rule) ?? 0) + finding.count);
  };

  const messages = session.messages.map((message) => {
    const result = redactor.redact(message.text);
    bump(result.findings);
    return { ...message, text: result.text };
  });

  const toolResults = session.toolResults.map((result) => {
    const redacted = redactor.redact(result.output);
    bump(redacted.findings);
    return { ...result, output: redacted.text };
  });

  const sanitized: SanitizedSession = {
    ...session,
    messages,
    toolResults,
    redactionFindings: [...findings.entries()].map(([rule, count]) => ({ rule, count })),
  };
  return { session: sanitized, findings: sanitized.redactionFindings };
}

/**
 * Builds the evidence set an extractor may cite.
 *
 * Only two sources qualify: messages the user actually wrote, and tool results
 * that report success. Assistant messages are deliberately excluded — a model's
 * own earlier answer can never become evidence about the user.
 */
export function extractEvidence(input: {
  session: SanitizedSession;
  caseId: string;
  evidenceIdFor: (sessionId: string, eventId: string, kind: string) => string;
}): EvidenceCandidate[] {
  const { session } = input;
  const candidates: EvidenceCandidate[] = [];

  for (const message of session.messages) {
    if (message.role !== 'user') continue;
    const snippet = message.text.trim().slice(0, MAX_SNIPPET_CHARS);
    if (snippet.length < 4) continue;
    candidates.push({
      evidenceId: input.evidenceIdFor(session.meta.sessionId, message.eventId, 'user_message'),
      eventId: message.eventId,
      kind: 'user_message',
      authority: 'user_explicit',
      toolName: null,
      verified: false,
      snippet,
    });
    if (candidates.length >= MAX_EVIDENCE_PER_KIND * 2) break;
  }

  let toolCount = 0;
  for (const result of session.toolResults) {
    if (!result.success) continue;
    const snippet = result.output.trim().slice(0, MAX_SNIPPET_CHARS);
    if (snippet.length < 4) continue;
    candidates.push({
      evidenceId: input.evidenceIdFor(session.meta.sessionId, result.eventId, 'tool_result'),
      eventId: result.eventId,
      kind: 'tool_result',
      authority: 'tool_verified',
      toolName: result.toolName,
      verified: true,
      snippet,
    });
    toolCount += 1;
    if (toolCount >= MAX_EVIDENCE_PER_KIND) break;
  }

  return candidates;
}

/** A conservative check that nothing credential-shaped survived redaction. */
export function assertNoSecrets(text: string, redactor: Redactor, context: string): void {
  const result = redactor.redact(text);
  if (result.redacted) {
    throw new Error(
      `Refusing to persist ${context}: it still contains credential-shaped content (${result.findings
        .map((finding) => finding.rule)
        .join(', ')}).`,
    );
  }
}
