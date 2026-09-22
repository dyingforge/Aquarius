/**
 * Structured local logging. Every emitted line passes through the configured
 * scrubber (the same deterministic redaction used before model calls) so tokens,
 * keys and credential-shaped strings never reach a log sink. Request bodies are
 * never logged in full — callers log summaries, latency, token counts, model
 * version and error category instead.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  level?: LogLevel;
  scrub?: (text: string) => string;
  sink?: LogSink;
}

let globalLevel: LogLevel = 'info';
let globalScrub: (text: string) => string = (text) => text;
let globalSink: LogSink | undefined;

export function configureLogging(options: LoggerOptions): void {
  if (options.level) globalLevel = options.level;
  if (options.scrub) globalScrub = options.scrub;
  globalSink = options.sink;
}

function defaultSink(record: LogRecord): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function emit(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;
  const record: LogRecord = {
    time: new Date().toISOString(),
    level,
    scope,
    message: globalScrub(message),
  };
  for (const [key, value] of Object.entries(fields ?? {})) {
    record[key] = typeof value === 'string' ? globalScrub(value) : scrubDeep(value);
  }
  (globalSink ?? defaultSink)(record);
}

function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return globalScrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(item);
    }
    return out;
  }
  return value;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => emit('debug', scope, message, fields),
    info: (message, fields) => emit('info', scope, message, fields),
    warn: (message, fields) => emit('warn', scope, message, fields),
    error: (message, fields) => emit('error', scope, message, fields),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}
