import { fileURLToPath } from 'node:url';

import type {
  ActorId,
  AgentId,
  OauthClientId,
  OauthCodeId,
  OauthGrantId,
  OauthRefreshTokenId,
  UserId,
  WorkspaceId,
} from '@knoverge/contracts';
import {
  EventLedger,
  WorkspaceService,
  newId,
  parseLedgerKey,
  type OauthClientRecord,
  type OauthGrantRecord,
} from '@knoverge/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createActorRepository,
  createAgentRepository,
  createCredentialRepository,
  createDatabase,
  createEventRepository,
  createOauthClientRepository,
  createOauthCodeRepository,
  createOauthGrantRepository,
  createOauthRefreshTokenRepository,
  createUnitOfWork,
  createUserRepository,
  createWorkspaceRepository,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const key = parseLedgerKey('d'.repeat(64));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let uow: ReturnType<typeof createUnitOfWork>;
let clients: ReturnType<typeof createOauthClientRepository>;
let grants: ReturnType<typeof createOauthGrantRepository>;
let codes: ReturnType<typeof createOauthCodeRepository>;
let refreshTokens: ReturnType<typeof createOauthRefreshTokenRepository>;
let credentials: ReturnType<typeof createCredentialRepository>;

let workspaceId: WorkspaceId;
let systemActorId: ActorId;
let userId: UserId;
let agentId: AgentId;

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 29, 12, minutes));

/** A registration, which grants nothing until somebody consents. */
async function registerClient(name: string, createdAt = at(0)): Promise<OauthClientRecord> {
  const client: OauthClientRecord = {
    id: newId('oacl') as OauthClientId,
    clientId: `cid-${name}`,
    clientSecretHash: null,
    name,
    redirectUris: ['https://chat.example/callback'],
    tokenEndpointAuthMethod: 'none',
    createdAt,
    lastUsedAt: null,
  };
  await uow.run((tx) => clients.insert(tx, client));
  return client;
}

async function consent(client: OauthClientRecord): Promise<OauthGrantRecord> {
  const grant: OauthGrantRecord = {
    id: newId('oagr') as OauthGrantId,
    clientId: client.id,
    userId,
    workspaceId,
    agentId,
    resource: 'https://knoverge.example/mcp',
    scope: null,
    createdAt: at(1),
    revokedAt: null,
  };
  await uow.run((tx) => grants.insert(tx, grant));
  return grant;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 8 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  uow = createUnitOfWork(handle.db);
  clients = createOauthClientRepository(handle.db);
  grants = createOauthGrantRepository(handle.db);
  codes = createOauthCodeRepository();
  refreshTokens = createOauthRefreshTokenRepository(handle.db);
  credentials = createCredentialRepository(handle.db);

  const actors = createActorRepository(handle.db);
  const workspaces = createWorkspaceRepository(handle.db);
  const ledger = new EventLedger({ key, events: createEventRepository(handle.db) });
  const service = new WorkspaceService({ uow, workspaces, actors, ledger });
  const ws = await service.create({ slug: 'personal', name: 'Personal', requestId: 'req-1' });
  workspaceId = ws.id;
  systemActorId = (await actors.findSystemActor(workspaceId))!.id;

  const users = createUserRepository(handle.db);
  userId = newId('usr') as UserId;
  await uow.run((tx) =>
    users.insert(tx, {
      id: userId,
      email: 'person@example.com',
      passwordHash: 'x',
      displayName: 'A Person',
      locale: 'en',
      status: 'active',
      failedLoginCount: 0,
      lockedUntil: null,
      passwordChangedAt: at(0),
      createdAt: at(0),
      lastLoginAt: null,
      termsVersion: null,
      termsAcceptedAt: null,
    }),
  );

  // The agent a consent would have created, and the actor that is it.
  const agents = createAgentRepository(handle.db);
  agentId = newId('ag') as AgentId;
  const agentActorId = newId('act') as ActorId;
  await uow.run(async (tx) => {
    await actors.insert(tx, {
      id: agentActorId,
      workspaceId,
      type: 'agent',
      displayName: 'ChatGPT (A Person)',
      userId: null,
      agentId,
      createdAt: at(1),
      disabledAt: null,
    });
    await agents.insert(tx, {
      id: agentId,
      workspaceId,
      actorId: agentActorId,
      name: 'ChatGPT (A Person)',
      description: null,
      clientType: 'chatgpt',
      trustTier: 'propose',
      status: 'active',
      createdByActorId: systemActorId,
      createdAt: at(1),
      lastSeenAt: null,
      metadata: {},
    });
  });
});

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
});

describe('a grant', () => {
  it('is one per client, person and workspace while it is live', async () => {
    const client = await registerClient('one-live');
    await consent(client);
    // Consenting again must resume the grant that is there rather than making a
    // second one: two live grants would be two agents for one connection, and
    // the ledger would have two answers to who wrote something.
    await expect(consent(client)).rejects.toThrow();

    const live = await grants.findLive(client.id, userId, workspaceId);
    expect(live).not.toBeNull();
  });

  it('can be granted again once the old one is revoked', async () => {
    const client = await registerClient('regrant');
    const first = await consent(client);
    expect(await uow.run((tx) => grants.revoke(tx, first.id, at(5)))).toBe(true);
    expect(await grants.findLive(client.id, userId, workspaceId)).toBeNull();

    const second = await consent(client);
    expect(second.id).not.toBe(first.id);
    expect((await grants.findLive(client.id, userId, workspaceId))?.id).toBe(second.id);
  });

  it('is revoked once, and says so the second time', async () => {
    const client = await registerClient('revoke-twice');
    const grant = await consent(client);
    expect(await uow.run((tx) => grants.revoke(tx, grant.id, at(5)))).toBe(true);
    expect(await uow.run((tx) => grants.revoke(tx, grant.id, at(6)))).toBe(false);
  });
});

describe('an authorization code', () => {
  async function issueCode(grantId: OauthGrantId, hash: string, expiresAt: Date) {
    await uow.run((tx) =>
      codes.insert(tx, {
        id: newId('oacd') as OauthCodeId,
        grantId,
        codeHash: hash,
        redirectUri: 'https://chat.example/callback',
        codeChallenge: 'c'.repeat(43),
        codeChallengeMethod: 'S256',
        resource: 'https://knoverge.example/mcp',
        createdAt: at(1),
        expiresAt,
        consumedAt: null,
      }),
    );
  }

  it('is spent once, and a second presentation gets nothing', async () => {
    const grant = await consent(await registerClient('code-once'));
    await issueCode(grant.id, 'sha256:code-once', at(10));

    const first = await uow.run((tx) => codes.consume(tx, 'sha256:code-once', at(2)));
    expect(first?.grantId).toBe(grant.id);
    // The replay. Whoever holds the code the second time is not the client.
    const second = await uow.run((tx) => codes.consume(tx, 'sha256:code-once', at(3)));
    expect(second).toBeNull();
  });

  it('is nothing once it has expired', async () => {
    const grant = await consent(await registerClient('code-expired'));
    await issueCode(grant.id, 'sha256:code-expired', at(2));
    expect(await uow.run((tx) => codes.consume(tx, 'sha256:code-expired', at(3)))).toBeNull();
  });

  it('that nobody spent is cleared away once it is stale', async () => {
    const grant = await consent(await registerClient('code-swept'));
    await issueCode(grant.id, 'sha256:code-swept', at(2));
    expect(await uow.run((tx) => codes.deleteExpired(tx, at(30)))).toBeGreaterThanOrEqual(1);
    expect(await uow.run((tx) => codes.consume(tx, 'sha256:code-swept', at(3)))).toBeNull();
  });
});

describe('a refresh token', () => {
  async function issueRefresh(grantId: OauthGrantId, hash: string) {
    const id = newId('oart') as OauthRefreshTokenId;
    await uow.run((tx) =>
      refreshTokens.insert(tx, {
        id,
        grantId,
        tokenHash: hash,
        createdAt: at(1),
        expiresAt: at(600),
        usedAt: null,
        replacedById: null,
        revokedAt: null,
      }),
    );
    return id;
  }

  it('rotates once, and the second exchange is refused', async () => {
    const grant = await consent(await registerClient('rotate'));
    const first = await issueRefresh(grant.id, 'sha256:refresh-1');
    const second = await issueRefresh(grant.id, 'sha256:refresh-2');

    expect(await uow.run((tx) => refreshTokens.rotate(tx, first, second, at(4)))).toBe(true);
    const third = await issueRefresh(grant.id, 'sha256:refresh-3');
    // Presenting a retired token means it was captured. The caller turns this
    // false into revoking the grant; what the repository promises is that it
    // cannot be exchanged twice.
    expect(await uow.run((tx) => refreshTokens.rotate(tx, first, third, at(5)))).toBe(false);

    const stored = await refreshTokens.findByTokenHash('sha256:refresh-1');
    expect(stored?.usedAt).toEqual(at(4));
    expect(stored?.replacedById).toBe(second);
  });

  it('cannot be exchanged after the grant was revoked', async () => {
    const grant = await consent(await registerClient('rotate-revoked'));
    const token = await issueRefresh(grant.id, 'sha256:refresh-revoked');
    const next = await issueRefresh(grant.id, 'sha256:refresh-revoked-next');

    expect(await uow.run((tx) => refreshTokens.revokeAllForGrant(tx, grant.id, at(7)))).toBe(2);
    expect(await uow.run((tx) => refreshTokens.rotate(tx, token, next, at(8)))).toBe(false);
  });
});

describe('the credentials a grant issued', () => {
  it('are revoked with it, and nobody else’s are', async () => {
    const mine = await consent(await registerClient('creds-mine'));
    const theirs = await consent(await registerClient('creds-theirs'));

    const issue = async (grantId: OauthGrantId | null, hash: string) => {
      const id = newId('cred');
      await uow.run((tx) =>
        credentials.insert(tx, {
          id,
          agentId,
          tokenHash: hash,
          tokenPrefix: hash.slice(-8),
          label: null,
          oauthGrantId: grantId,
          createdByActorId: systemActorId,
          createdAt: at(2),
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
        }),
      );
      return id;
    };

    const a = await issue(mine.id, 'sha256:cred-a');
    const b = await issue(theirs.id, 'sha256:cred-b');
    // One issued by hand, which no grant may touch.
    const c = await issue(null, 'sha256:cred-c');

    expect(await uow.run((tx) => credentials.revokeAllForGrant(tx, mine.id, at(9)))).toBe(1);
    expect((await credentials.findById(a))?.revokedAt).toEqual(at(9));
    expect((await credentials.findById(b))?.revokedAt).toBeNull();
    expect((await credentials.findById(c))?.revokedAt).toBeNull();
  });
});

describe('a registration nobody consented to', () => {
  it('is cleared away, and one that holds a grant is kept', async () => {
    const abandoned = await registerClient('abandoned', at(0));
    const used = await registerClient('used', at(0));
    await consent(used);

    const removed = await uow.run((tx) => clients.deleteUnconsented(tx, at(60)));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await clients.findById(abandoned.id)).toBeNull();
    expect(await clients.findById(used.id)).not.toBeNull();
  });

  it('is kept while it is still new enough to be finishing', async () => {
    const fresh = await registerClient('fresh', at(50));
    await uow.run((tx) => clients.deleteUnconsented(tx, at(40)));
    expect(await clients.findById(fresh.id)).not.toBeNull();
  });
});
