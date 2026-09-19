import type { SessionRecord, UserRecord } from '@knoverge/core';
import { DomainError } from '@knoverge/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Services } from '../services.ts';
import { SESSION_COOKIE } from './security.ts';

export interface HumanAuth {
  user: UserRecord;
  session: SessionRecord;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved from the session cookie; null when anonymous. */
    humanAuth: HumanAuth | null;
  }
}

/**
 * Resolves the session cookie on every request. Never throws: routes decide
 * with requireUser whether anonymity is acceptable.
 */
export function registerAuthContext(app: FastifyInstance, services: Services): void {
  app.addHook('onRequest', async (request) => {
    // Static assets and the SPA shell never need the session; avoid a query per asset.
    if (!request.url.startsWith('/v1/')) return;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await services.sessions.resolve(token);
    if (!session) return;
    const user = await services.users.findById(session.userId);
    if (!user || user.status !== 'active') return;
    request.humanAuth = { user, session };
  });
}

export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.humanAuth) {
    throw new DomainError('UNAUTHENTICATED', 'sign in required');
  }
}
