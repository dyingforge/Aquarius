import { AquariusService, createLogger, loadConfig, requireUsableConfig, type AquariusConfig } from '@aquarius/core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';

const log = createLogger('server');

export interface BootstrappedServer {
  service: AquariusService;
  app: FastifyInstance;
  config: AquariusConfig;
}

/**
 * Builds the service for an HTTP server.
 *
 * `persistToken` is true only on the real startup path: the first start
 * generates the local API token and writes it to the config file with 0600
 * permissions. Tests and tools never silently mint tokens.
 */
export async function bootstrapServer(options: {
  persistToken?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): Promise<BootstrappedServer> {
  const loaded = await requireUsableConfig({
    persistToken: options.persistToken ?? false,
    ...(options.env ? { env: options.env } : {}),
    ...(options.home ? { home: options.home } : {}),
  });
  const service = await AquariusService.create({ config: loaded.config, configIssues: loaded.issues });
  const bootstrap = await service.bootstrap();
  log.info('service ready', {
    version: (await service.health()).version,
    head: bootstrap.reconcile.head?.slice(0, 12) ?? null,
    runtime: service.runtime.mode,
    schedule: bootstrap.schedule.created ? 'catch-up created' : bootstrap.schedule.reason,
  });
  const app = buildApp({ service });
  return { service, app, config: loaded.config };
}

/** Loads configuration without initializing the service (used by `doctor`-style tooling). */
export async function loadServerConfig(options: { env?: NodeJS.ProcessEnv } = {}): Promise<AquariusConfig> {
  const loaded = await loadConfig(options.env ? { env: options.env } : {});
  return loaded.config;
}
