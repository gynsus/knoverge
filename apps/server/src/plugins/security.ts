import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance, onRequestHookHandler } from 'fastify';

export interface SecurityOptions {
  /** Hex secret used to sign the CSRF cookie. */
  sessionSecret: string;
  cookieSecure: boolean;
}

export const SESSION_COOKIE = 'knoverge_session';
export const CSRF_COOKIE = 'knoverge_csrf';

/**
 * Web security baseline (SECURITY.md section 3): headers, cookies, CSRF, rate limits.
 */
export async function registerSecurity(
  app: FastifyInstance,
  options: SecurityOptions,
): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        // No 'unsafe-inline': the interface carries no inline style attribute
        // and no style element, so allowing them would widen the policy for
        // nothing. A change that needs one must add a nonce instead.
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'object-src': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: options.cookieSecure
      ? { maxAge: 15_552_000, includeSubDomains: true }
      : false,
  });

  await app.register(fastifyCookie, { secret: options.sessionSecret });

  await app.register(fastifyCsrf, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: CSRF_COOKIE,
    cookieOpts: {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: options.cookieSecure,
      path: '/',
    },
  });
}

/**
 * Per-actor rate limiting. Registered after the authentication hooks so the key
 * can be the caller rather than the address: several agents behind one proxy get
 * their own budgets, and one noisy caller cannot spend everyone else's.
 *
 * Route-level `config.rateLimit` overrides this default, as login and bootstrap do.
 */
export async function registerRateLimits(
  app: FastifyInstance,
  options: { max?: number; timeWindow?: string } = {},
): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: true,
    max: options.max ?? 600,
    timeWindow: options.timeWindow ?? '1 minute',
    keyGenerator: (request) => {
      if (request.agentAuth) return `agent:${request.agentAuth.agent.id}`;
      if (request.humanAuth) return `user:${request.humanAuth.user.id}`;
      return `ip:${request.ip}`;
    },
  });
}

/**
 * CSRF applies to cookie-authenticated browsers only. A bearer token carries no
 * ambient authority, so an agent request is not forgeable this way and must not
 * be asked for a token it cannot obtain.
 */
export function csrfUnlessBearer(app: FastifyInstance): onRequestHookHandler {
  return function csrfForBrowsers(request, reply, done) {
    // The header being present is what matters, not whether it resolved. A
    // browser never attaches Authorization on its own, so the protection is
    // unchanged; but keying on the resolved agent meant an expired or revoked
    // token was answered with FORBIDDEN by the CSRF hook, before the route
    // could say UNAUTHENTICATED. An agent could not tell "rotate your token"
    // from "you may not do this", and was told not to retry either way.
    const authorization = request.headers.authorization;
    if (request.agentAuth || authorization?.toLowerCase().startsWith('bearer ')) {
      done();
      return;
    }
    app.csrfProtection(request, reply, done);
  };
}
