import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

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
        'style-src': ["'self'", "'unsafe-inline'"],
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

  await app.register(fastifyRateLimit, {
    global: false,
    // Per-route limits are declared in route config; bearer-token limits arrive with agents.
  });
}
