import type { AquariusConfig } from '../config.ts';
import type { SessionSourceAdapter } from './adapter.ts';
import { CodexSessionAdapter } from './codex/codexAdapter.ts';

/**
 * Adapter registry. Adding another agent source means implementing
 * `SessionSourceAdapter` and registering it here — nothing downstream changes.
 */
export class AdapterRegistry {
  readonly #adapters: Map<string, SessionSourceAdapter>;

  constructor(adapters: SessionSourceAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.source, adapter]));
  }

  static fromConfig(config: AquariusConfig): AdapterRegistry {
    return new AdapterRegistry([new CodexSessionAdapter({ paths: config.sources })]);
  }

  get(source: string): SessionSourceAdapter | null {
    return this.#adapters.get(source) ?? null;
  }

  list(): SessionSourceAdapter[] {
    return [...this.#adapters.values()];
  }

  defaultSource(): SessionSourceAdapter {
    const [first] = this.list();
    if (!first) throw new Error('No session source adapters are registered');
    return first;
  }

  describe(): { source: string; schemaVersion: number; paths: string[]; available: boolean }[] {
    return this.list().map((adapter) => ({
      source: adapter.source,
      schemaVersion: adapter.schemaVersion,
      ...adapter.describeSource(),
    }));
  }
}
