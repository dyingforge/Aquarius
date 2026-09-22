import type { FastifyRequest } from 'fastify';
import { AquariusError } from '@aquarius/core';

/**
 * Local-only authentication.
 *
 * Two independent conditions must hold for every request except `/health`:
 * the TCP peer must be loopback, and the bearer token must match the configured
 * local token. Non-localhost requests are rejected outright — the service is for
 * one user on one machine and never listens publicly.
 */

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface AuthContext {
  verifyToken: (token: string) => boolean;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK_ADDRESSES.has(address);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export function requireLocalAndAuthenticated(request: FastifyRequest, context: AuthContext): void {
  const remote = request.socket.remoteAddress ?? undefined;
  if (!isLoopbackAddress(remote)) {
    throw new AquariusError('forbidden', `Requests must originate from loopback; remote address was ${remote ?? 'unknown'}.`);
  }

  // A mismatched Host header is a strong signal that a request was relayed.
  const host = request.headers.host;
  if (typeof host === 'string') {
    const hostname = host.split(':')[0] ?? '';
    if (hostname !== '' && hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1') {
      throw new AquariusError('forbidden', `Refusing a request addressed to host "${hostname}". Aquarius only serves localhost.`);
    }
  }

  const token = extractBearerToken(request.headers.authorization);
  if (token === null) {
    throw new AquariusError('unauthorized', 'Missing bearer token.', {
      actionable: 'Send `Authorization: Bearer <token>` using the token from the Aquarius config file.',
    });
  }
  if (!context.verifyToken(token)) {
    throw new AquariusError('unauthorized', 'Invalid bearer token.');
  }
}
