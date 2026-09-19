import type { SessionId, UserId } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { TokenService } from './ports.ts';
import type { SessionRecord, SessionRepository } from './repository.ts';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionServiceOptions {
  uow: UnitOfWork;
  sessions: SessionRepository;
  tokens: TokenService;
  clock?: Clock;
  ttlMs?: number;
}

export interface IssuedSession {
  session: SessionRecord;
  /** The bearer value for the cookie. Never stored. */
  token: string;
}

export class SessionService {
  private readonly uow: UnitOfWork;
  private readonly sessions: SessionRepository;
  private readonly tokens: TokenService;
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(options: SessionServiceOptions) {
    this.uow = options.uow;
    this.sessions = options.sessions;
    this.tokens = options.tokens;
    this.clock = options.clock ?? systemClock;
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  }

  async issue(userId: UserId, meta: { userAgent?: string; ip?: string }): Promise<IssuedSession> {
    const token = this.tokens.generate();
    const now = this.clock.now();
    const session: SessionRecord = {
      id: newId('sess') as SessionId,
      userId,
      tokenHash: this.tokens.hash(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
      revokedAt: null,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
    };
    await this.uow.run((tx) => this.sessions.insert(tx, session));
    return { session, token };
  }

  /** Resolves a cookie value to an active session, or null. */
  resolve(token: string): Promise<SessionRecord | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.resolve(null);
    return this.sessions.findActiveByTokenHash(this.tokens.hash(token), this.clock.now());
  }

  list(userId: UserId): Promise<SessionRecord[]> {
    return this.sessions.listActiveForUser(userId, this.clock.now());
  }

  async revoke(userId: UserId, sessionId: SessionId): Promise<void> {
    const owned = (await this.list(userId)).some((s) => s.id === sessionId);
    if (!owned) throw new DomainError('NOT_FOUND', 'session not found');
    await this.uow.run((tx) => this.sessions.revoke(tx, sessionId, this.clock.now()));
  }

  revokeAll(userId: UserId, except?: SessionId): Promise<number> {
    return this.uow.run((tx) =>
      this.sessions.revokeAllForUser(tx, userId, this.clock.now(), except),
    );
  }
}
