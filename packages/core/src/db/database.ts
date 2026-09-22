import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { ensureDir } from '../util/fsx.ts';
import { nowIso } from '../util/time.ts';
import { MIGRATIONS, LATEST_SCHEMA_VERSION, type SqlParams, type SqlValue } from './migrations.ts';
import { AquariusError } from '../errors.ts';

export interface QueryRow {
  [column: string]: SqlValue;
}

export interface MigrationReport {
  applied: number[];
  currentVersion: number;
  freshDatabase: boolean;
}

export class AquariusDatabase {
  readonly #db: DatabaseSync;
  readonly path: string;
  #closed = false;

  private constructor(db: DatabaseSync, path: string) {
    this.#db = db;
    this.path = path;
  }

  static async open(path: string, options: { readOnly?: boolean } = {}): Promise<AquariusDatabase> {
    if (!options.readOnly) await ensureDir(dirname(path));
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, options.readOnly ? { readOnly: true } : {});
    } catch (error) {
      throw new AquariusError('config_invalid', `Cannot open SQLite database at ${path}: ${(error as Error).message}`, {
        actionable: 'Check file permissions, or delete the database and rebuild the search index from Git.',
        cause: error,
      });
    }
    const handle = new AquariusDatabase(db, path);
    if (!options.readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    return handle;
  }

  /** In-memory database, used by tests. */
  static async openInMemory(): Promise<AquariusDatabase> {
    const db = new DatabaseSync(':memory:');
    const handle = new AquariusDatabase(db, ':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    return handle;
  }

  get raw(): DatabaseSync {
    return this.#db;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number | bigint } {
    const statement = this.#db.prepare(sql);
    const result = statement.run(...(bindArgs(params) as BoundArgs));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid as number | bigint };
  }

  get<T = QueryRow>(sql: string, params?: SqlParams): T | undefined {
    const statement = this.#db.prepare(sql);
    const rows = statement.all(...(bindArgs(params) as BoundArgs));
    return rows[0] as T | undefined;
  }

  all<T = QueryRow>(sql: string, params?: SqlParams): T[] {
    const statement = this.#db.prepare(sql);
    return statement.all(...(bindArgs(params) as BoundArgs)) as T[];
  }

  prepare(sql: string): StatementSync {
    return this.#db.prepare(sql);
  }

  /** Immediate transaction: serializes writers so a single-writer guarantee holds. */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // The transaction was already rolled back by SQLite.
      }
      throw error;
    }
  }

  get schemaVersion(): number {
    const row = this.get<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations');
    return row?.version ?? 0;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  get closed(): boolean {
    return this.#closed;
  }
}

/** node:sqlite takes an array as positional parameters and an object as named ones. */
function bindArgs(params: SqlParams | undefined): SqlValue[] | [Record<string, SqlValue>] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params;
  return [params];
}

type BoundArgs = Parameters<StatementSync['all']>;

/**
 * Applies pending migrations. Statement-level DDL in SQLite is atomic per
 * statement, so each migration runs inside its own immediate transaction.
 */
export async function migrate(database: AquariusDatabase): Promise<MigrationReport> {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const currentVersion = database.schemaVersion;
  const freshDatabase = currentVersion === 0;
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    database.transaction(() => {
      for (const statement of migration.statements) database.exec(statement);
      database.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        nowIso(),
      ]);
    });
    applied.push(migration.version);
  }

  return { applied, currentVersion: database.schemaVersion, freshDatabase };
}

/** Convenience used by the service and by `doctor`. */
export async function openAndMigrate(path: string): Promise<{ database: AquariusDatabase; report: MigrationReport }> {
  const database = await AquariusDatabase.open(path);
  const report = await migrate(database);
  return { database, report };
}

export { LATEST_SCHEMA_VERSION };
export type { SqlParams, SqlValue };
