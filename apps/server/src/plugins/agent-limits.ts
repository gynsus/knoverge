import { DomainError } from '@knoverge/core';
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';

/**
 * How many requests one credential may have in flight at once.
 *
 * A rate limit counts requests over a minute and says nothing about how many
 * are running right now: a client that opens fifty connections and holds them
 * is inside every per-minute budget while occupying fifty database
 * connections and fifty workspace lock waiters. This is the other half.
 *
 * Generous enough that an agent working in parallel never meets it, low
 * enough that one misbehaving client cannot take the server down for the
 * others.
 */
export const MAX_CONCURRENT_PER_CREDENTIAL = 8;

/** What a tool call may carry. The global body limit is the ceiling above it. */
export const MAX_TOOL_BODY_BYTES = 512 * 1024;

/**
 * Per-class budgets, in requests per minute per credential.
 *
 * A read is cheap and an agent doing useful work makes many; a write takes
 * the workspace lock, makes a commit and appends to the ledger, and one
 * agent making hundreds a minute is either broken or hostile. The plan asks
 * for separate buckets, and these are the two that exist to separate.
 */
export const AGENT_LIMITS = {
  read: { max: 600, timeWindow: '1 minute' },
  write: { max: 60, timeWindow: '1 minute' },
} as const;

/** In-flight requests, by credential. Per process, which is where they run. */
const inFlight = new Map<string, number>();

/** Who to count against: the credential, or the person, or the address. */
function keyFor(request: FastifyRequest): string {
  if (request.agentAuth) return `cred:${request.agentAuth.credential.id}`;
  if (request.humanAuth) return `user:${request.humanAuth.user.id}`;
  return `ip:${request.ip}`;
}

/**
 * Refuses a caller already running as much as it may.
 *
 * Registered on the routes an agent reaches, rather than globally: a person
 * loading a page makes a handful of parallel requests and must not be told to
 * slow down for it, and the browser routes are not what a runaway client
 * hammers.
 */
export function limitConcurrency(app: FastifyInstance): onRequestHookHandler {
  return function concurrency(request, reply, done) {
    const key = keyFor(request);
    const running = inFlight.get(key) ?? 0;
    if (running >= MAX_CONCURRENT_PER_CREDENTIAL) {
      done(
        new DomainError(
          'RATE_LIMITED',
          `too many requests in flight for this credential; at most ${MAX_CONCURRENT_PER_CREDENTIAL} at once`,
          { retryable: true },
        ),
      );
      return;
    }
    inFlight.set(key, running + 1);
    // On the response rather than on the handler returning: a request that
    // failed still occupied the slot until it did.
    const release = () => {
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left <= 0) inFlight.delete(key);
      else inFlight.set(key, left);
    };
    reply.raw.once('close', release);
    void app;
    done();
  };
}

/** For tests: nothing in flight, whatever an interrupted run left behind. */
export function resetConcurrency(): void {
  inFlight.clear();
}
