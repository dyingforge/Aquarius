import { execFile } from 'node:child_process';
import { createLogger } from '../util/logger.ts';

const log = createLogger('git');

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunGitOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  input?: string;
  /** Return the result instead of throwing on a non-zero exit code. */
  allowFailure?: boolean;
  maxBufferBytes?: number;
}

export class GitCommandError extends Error {
  readonly args: string[];
  readonly code: number;
  readonly stderr: string;

  constructor(args: string[], code: number, stderr: string) {
    super(`git ${args.join(' ')} exited with ${code}: ${stderr.trim().split('\n')[0] ?? ''}`);
    this.name = 'GitCommandError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

/** Narrow wrapper around the native Git CLI — the only place Aquarius shells out. */
export async function runGit(args: string[], options: RunGitOptions): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    // Deterministic, non-interactive behaviour: no pager, no prompts, no credential helpers.
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  return new Promise<GitResult>((resolvePromise, rejectPromise) => {
    const child = execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        env,
        maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
        if (error && !options.allowFailure) {
          rejectPromise(new GitCommandError(args, code, stderr ?? String(error.message)));
          return;
        }
        resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

export async function gitVersion(): Promise<string | null> {
  try {
    const result = await runGit(['--version'], { cwd: process.cwd() });
    return result.stdout.trim();
  } catch (error) {
    log.debug('git is not available', { message: (error as Error).message });
    return null;
  }
}

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
