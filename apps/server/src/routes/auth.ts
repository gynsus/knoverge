import {
  AuthStatusResponse,
  BootstrapRequest,
  BootstrapResponse,
  ChangeEmailRequest,
  ChangePasswordRequest,
  CsrfResponse,
  LoginRequest,
  MeResponse,
  OkResponse,
  RevokeSessionRequest,
  SessionsResponse,
  type MembershipSummary,
} from '@knoverge/contracts';
import { SESSION_TTL_MS, type SessionRecord, type UserRecord } from '@knoverge/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requireUser, type HumanAuth } from '../plugins/auth-context.ts';
import { CSRF_COOKIE, SESSION_COOKIE } from '../plugins/security.ts';
import type { Services } from '../services.ts';

export interface AuthRouteOptions {
  services: Services;
  cookieSecure: boolean;
}

const LOGIN_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
const BOOTSTRAP_LIMIT = { max: 5, timeWindow: '1 minute' } as const;

function userSummary(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    locale: user.locale as 'en' | 'ru',
    status: user.status,
    created_at: user.createdAt.toISOString(),
    last_login_at: user.lastLoginAt?.toISOString() ?? null,
  };
}

async function meResponse(services: Services, auth: HumanAuth) {
  const memberships: MembershipSummary[] = (
    await services.repositories.memberships.listForUser(auth.user.id)
  ).map((m) => ({
    workspace_id: m.workspaceId,
    workspace_slug: m.workspaceSlug,
    workspace_name: m.workspaceName,
    role: m.role,
  }));
  return {
    user: userSummary(auth.user),
    memberships,
    session: { id: auth.session.id, expires_at: auth.session.expiresAt.toISOString() },
  };
}

function clientMeta(request: FastifyRequest) {
  const ua = request.headers['user-agent'];
  return { ...(ua ? { userAgent: ua } : {}), ip: request.ip };
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { services, cookieSecure } = options;
  const r = app.withTypeProvider<ZodTypeProvider>();

  const setSessionCookie = (reply: FastifyReply, token: string, session: SessionRecord) => {
    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure,
      path: '/',
      expires: session.expiresAt,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  };
  const clearSessionCookie = (reply: FastifyReply) => {
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    // The CSRF secret is bound to the user, so leaving it behind would hand
    // the next person on this browser a token minted for someone else.
    void reply.clearCookie(CSRF_COOKIE, { path: '/' });
  };

  r.get(
    '/v1/auth/status',
    { schema: { response: { 200: AuthStatusResponse } } },
    async (request) => ({
      bootstrap_required: await services.bootstrap.isRequired(),
      authenticated: request.humanAuth !== null,
    }),
  );

  r.get(
    '/v1/auth/csrf',
    { schema: { response: { 200: CsrfResponse } } },
    async (_request, reply) => ({
      token: await reply.generateCsrf(),
    }),
  );

  r.post(
    '/v1/bootstrap',
    {
      onRequest: app.csrfProtection,
      config: { rateLimit: BOOTSTRAP_LIMIT },
      schema: { body: BootstrapRequest, response: { 200: BootstrapResponse } },
    },
    async (request, reply) => {
      const body = request.body;
      const result = await services.bootstrap.run({
        user: {
          email: body.email,
          password: body.password,
          displayName: body.display_name,
          locale: body.locale,
        },
        workspace: body.workspace,
        requestId: request.id,
      });
      const issued = await services.sessions.issue(result.user.id, clientMeta(request));
      setSessionCookie(reply, issued.token, issued.session);
      return { user_id: result.user.id, workspace_id: result.workspace.id };
    },
  );

  r.post(
    '/v1/auth/login',
    {
      onRequest: app.csrfProtection,
      config: { rateLimit: LOGIN_LIMIT },
      schema: { body: LoginRequest, response: { 200: MeResponse } },
    },
    async (request, reply) => {
      const user = await services.users.authenticate(request.body.email, request.body.password);
      const issued = await services.sessions.issue(user.id, clientMeta(request));
      setSessionCookie(reply, issued.token, issued.session);
      return meResponse(services, { user, session: issued.session });
    },
  );

  r.post(
    '/v1/auth/logout',
    {
      onRequest: app.csrfProtection,
      preHandler: requireUser,
      schema: { response: { 200: OkResponse } },
    },
    async (request, reply) => {
      const auth = request.humanAuth as HumanAuth;
      await services.sessions.revoke(auth.user.id, auth.session.id);
      clearSessionCookie(reply);
      return { ok: true as const };
    },
  );

  r.get(
    '/v1/auth/me',
    { preHandler: requireUser, schema: { response: { 200: MeResponse } } },
    async (request) => meResponse(services, request.humanAuth as HumanAuth),
  );

  r.post(
    '/v1/auth/password',
    {
      onRequest: app.csrfProtection,
      preHandler: requireUser,
      schema: { body: ChangePasswordRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const auth = request.humanAuth as HumanAuth;
      await services.users.changePassword(
        auth.user.id,
        request.body.current_password,
        request.body.new_password,
      );
      // Every other session must sign in again with the new password.
      await services.sessions.revokeAll(auth.user.id, auth.session.id);
      return { ok: true as const };
    },
  );

  r.post(
    '/v1/auth/email',
    {
      onRequest: app.csrfProtection,
      preHandler: requireUser,
      schema: { body: ChangeEmailRequest, response: { 200: OkResponse } },
    },
    async (request) => {
      const auth = request.humanAuth as HumanAuth;
      await services.users.changeEmail(
        auth.user.id,
        request.body.current_password,
        request.body.new_email,
      );
      // The address is what the account signs in with, so every other session
      // was opened against an identity that no longer exists.
      await services.sessions.revokeAll(auth.user.id, auth.session.id);
      return { ok: true as const };
    },
  );

  r.get(
    '/v1/auth/sessions',
    { preHandler: requireUser, schema: { response: { 200: SessionsResponse } } },
    async (request) => {
      const auth = request.humanAuth as HumanAuth;
      const sessions = await services.sessions.list(auth.user.id);
      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          created_at: s.createdAt.toISOString(),
          expires_at: s.expiresAt.toISOString(),
          user_agent: s.userAgent,
          ip: s.ip,
          current: s.id === auth.session.id,
        })),
      };
    },
  );

  r.post(
    '/v1/auth/sessions/revoke',
    {
      onRequest: app.csrfProtection,
      preHandler: requireUser,
      schema: { body: RevokeSessionRequest, response: { 200: OkResponse } },
    },
    async (request, reply) => {
      const auth = request.humanAuth as HumanAuth;
      await services.sessions.revoke(auth.user.id, request.body.session_id);
      if (request.body.session_id === auth.session.id) clearSessionCookie(reply);
      return { ok: true as const };
    },
  );
}
