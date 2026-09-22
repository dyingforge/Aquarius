#!/usr/bin/env node
import { configureLogging, createLogger, isAquariusError } from '@aquarius/core';
import { bootstrapServer } from './bootstrap.ts';

const log = createLogger('main');

async function main(): Promise<void> {
  let bootstrapped;
  try {
    bootstrapped = await bootstrapServer({ persistToken: true });
  } catch (error) {
    if (isAquariusError(error)) {
      // Configuration problems print as an actionable list, never as a stack trace.
      process.stderr.write(`aquarius: ${error.message}\n`);
      if (error.actionable) process.stderr.write(`  → ${error.actionable}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const { service, app, config } = bootstrapped;
  configureLogging({ level: config.logLevel, scrub: (text) => service.redactor.redact(text).text });

  service.start();

  try {
    await app.listen({ host: config.host, port: config.port });
    log.info('listening', { host: config.host, port: config.port, runtime: service.runtime.mode });
  } catch (error) {
    process.stderr.write(`aquarius: cannot listen on ${config.host}:${config.port}: ${(error as Error).message}\n`);
    await service.stop();
    process.exitCode = 3;
    return;
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutting down', { signal });
    try {
      await app.close();
    } catch {
      // Ignore: the process is going away regardless.
    }
    await service.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
