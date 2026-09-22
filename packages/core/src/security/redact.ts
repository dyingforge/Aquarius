/**
 * Deterministic, model-free secret detection. This runs before every model call,
 * every log line and every Git write — nothing else in the system is allowed to
 * hand raw session text to an external surface.
 *
 * The rules are intentionally conservative: they must never throw and must never
 * depend on the model. Anything a rule cannot classify stays unchanged.
 */

export interface RedactionFinding {
  rule: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
  redacted: boolean;
}

interface Rule {
  name: string;
  pattern: RegExp;
  /** Keeps a captured prefix (e.g. `password=`) visible while replacing the value. */
  replace?: (match: string, groups: (string | undefined)[]) => string;
}

const REDACTED = (rule: string): string => `[REDACTED:${rule}]`;

const BUILT_IN_RULES: Rule[] = [
  {
    name: 'private_key',
    pattern: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  { name: 'openai_key', pattern: /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'npm_token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'huggingface_token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'stripe_key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  {
    name: 'authorization_header',
    pattern: /(authorization\s*["']?\s*[:=]\s*)(["']?)(?:bearer\s+|basic\s+|token\s+)?[^\s"',;}\]]{8,}/gi,
    replace: (_match, groups) => `${groups[0] ?? ''}${groups[1] ?? ''}${REDACTED('authorization_header')}`,
  },
  {
    name: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  },
  {
    name: 'named_secret',
    pattern:
      /((?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret)\s*["']?\s*[:=]\s*)(["']?)([^\s"',;}\]\\)]{6,})/gi,
    replace: (_match, groups) => `${groups[0] ?? ''}${groups[1] ?? ''}${REDACTED('named_secret')}`,
  },
  {
    // Same idea in natural-language prose, including CJK phrasings such as
    // "密码是 …" or "密钥为 …", which carry no `key=value` punctuation.
    name: 'named_secret_prose',
    pattern:
      /((?:密码|口令|密钥|令牌|凭据|私钥|password|passphrase|secret|credential|token)\s*(?:是|为|＝|=|:|：)\s*)(["'`]?)([^\s"'`,;}\]）)]{4,})/gi,
    replace: (_match, groups) => `${groups[0] ?? ''}${groups[1] ?? ''}${REDACTED('named_secret_prose')}`,
  },
  {
    name: 'connection_string',
    pattern:
      /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|sqlserver):\/\/[^\s:@/]+:)([^@\s/]+)(@)/gi,
    replace: (_match, groups) => `${groups[0] ?? ''}${REDACTED('connection_string')}${groups[2] ?? ''}`,
  },
];

function compileExtraPattern(source: string): Rule | null {
  try {
    return { name: `custom:${source}`, pattern: new RegExp(source, 'g') };
  } catch {
    return null;
  }
}

export class Redactor {
  readonly #rules: Rule[];

  constructor(extraPatterns: string[] = []) {
    this.#rules = [...BUILT_IN_RULES, ...extraPatterns.map(compileExtraPattern).filter((rule): rule is Rule => rule !== null)];
  }

  /** Returns the redacted text plus a per-rule finding count. */
  redact(input: string): RedactionResult {
    let text = input;
    const findings: RedactionFinding[] = [];
    for (const rule of this.#rules) {
      let count = 0;
      text = text.replace(rule.pattern, (match: string, ...args: unknown[]) => {
        count += 1;
        if (!rule.replace) return REDACTED(rule.name);
        const groups = args.slice(0, -2) as (string | undefined)[];
        return rule.replace(match, groups);
      });
      if (count > 0) findings.push({ rule: rule.name, count });
    }
    return { text, findings, redacted: findings.length > 0 };
  }

  /** True when the text still looks like it carries a credential shape. */
  containsSecret(input: string): boolean {
    return this.redact(input).redacted;
  }

  get ruleNames(): string[] {
    return this.#rules.map((rule) => rule.name);
  }
}

export function createRedactor(extraPatterns: string[] = []): Redactor {
  return new Redactor(extraPatterns);
}

/** Zero-argument scrubber for the logging layer. */
export function createLogScrubber(extraPatterns: string[] = []): (text: string) => string {
  const redactor = new Redactor(extraPatterns);
  return (text: string) => redactor.redact(text).text;
}
