import { readTextIfExists } from '@aquarius/core';

export class CliError extends Error {
  readonly code: string;
  readonly actionable: string | undefined;
  readonly exitCode: number;

  constructor(code: string, message: string, actionable?: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.actionable = actionable;
    this.exitCode = exitCode;
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; actionable?: string };
}

/**
 * The CLI never duplicates business logic: it resolves the local token, calls the
 * local API, and formats the result. Every behaviour it exposes exists in the
 * service, so the CLI and HTTP surfaces cannot drift apart.
 */
export class ApiClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new CliError(
        'source_unavailable',
        `Cannot reach the Aquarius service at ${this.baseUrl}: ${(error as Error).message}`,
        'Start it with `aquarius` (or `pnpm server`), or set AQUARIUS_URL.',
        3,
      );
    }

    const text = await response.text();
    const payload: unknown = text === '' ? null : safeJson(text);

    if (!response.ok) {
      const body = (payload ?? {}) as ApiErrorBody;
      throw new CliError(
        body.error?.code ?? `http_${response.status}`,
        body.error?.message ?? `Request failed with status ${response.status}`,
        body.error?.actionable,
        response.status === 401 || response.status === 403 ? 4 : 1,
      );
    }
    return payload as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface ResolvedConfigFile {
  port?: number;
  host?: string;
  apiToken?: string;
}

export interface ResolveClientOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  url?: string;
  token?: string;
}

/** Resolves base URL and token from flags, environment, then the config file. */
export async function resolveClient(options: ResolveClientOptions = {}): Promise<ApiClient> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.AQUARIUS_HOME ?? `${process.env.HOME ?? ''}/.aquarius`;
  const configPath = `${home}/config.json`;
  const raw = await readTextIfExists(configPath);
  let file: ResolvedConfigFile = {};
  if (raw !== null) {
    try {
      file = JSON.parse(raw) as ResolvedConfigFile;
    } catch {
      throw new CliError('config_invalid', `Cannot parse ${configPath}.`, 'Fix or delete the file and retry.', 2);
    }
  }

  const token = options.token ?? env.AQUARIUS_API_TOKEN ?? file.apiToken;
  if (!token) {
    throw new CliError(
      'config_missing',
      'No local API token available.',
      `Start the service once to generate ${configPath}, or set AQUARIUS_API_TOKEN.`,
      2,
    );
  }

  const url =
    options.url ??
    env.AQUARIUS_URL ??
    `http://${file.host ?? env.AQUARIUS_HOST ?? '127.0.0.1'}:${Number(env.AQUARIUS_PORT ?? file.port ?? 8787)}`;

  return new ApiClient({ baseUrl: url, token });
}
