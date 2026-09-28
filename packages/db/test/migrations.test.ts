import { fileURLToPath } from 'node:url';

import {
  ActorType,
  AgentStatus,
  AiProviderKind,
  AiProviderOrigin,
  AiPurpose,
  CategoryStatus,
  ClassificationState,
  MatchReason,
  ChangeKind,
  EvidenceRole,
  EvidenceState,
  ItemType,
  MembershipRole,
  PermissionEffect,
  PolicyEffect,
  ProposalStatus,
  ProposalType,
  RelationType,
  ReviewState,
  SourceType,
  SyncClassification,
  SyncSessionState,
  TrustTier,
  UserStatus,
} from '@knoverge/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  getMigrationStatus,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 2 });
});

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

describe('migrations', () => {
  it('reports everything pending on an empty database', async () => {
    const status = await getMigrationStatus(handle.db, migrationsFolder);
    expect(status.applied).toBe(0);
    expect(status.total).toBeGreaterThan(0);
    expect(status.pending).toHaveLength(status.total);
  });

  it('applies all migrations and installs the required extensions', async () => {
    const result = await runMigrations(handle.db, migrationsFolder);
    expect(result.before.applied).toBe(0);
    expect(result.after.pending).toEqual([]);
    expect(result.after.applied).toBe(result.after.total);

    const ext = await handle.db.execute<{ extname: string }>(
      sql`SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'unaccent') ORDER BY extname`,
    );
    expect(ext.rows.map((r) => r.extname)).toEqual(['pg_trgm', 'unaccent', 'vector']);
  });

  it('is idempotent', async () => {
    const result = await runMigrations(handle.db, migrationsFolder);
    expect(result.before.pending).toEqual([]);
    expect(result.after.applied).toBe(result.before.applied);
  });
});

describe('the invariants the schema now states', () => {
  it('installs them, so a bad value is refused by the database and not only by a type', async () => {
    const rows = await handle.db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conname IN (
        'categories_parent_id_categories_id_fk',
        'categories_path_ends_with_slug',
        'actors_type_check',
        'agents_trust_tier_check',
        'categories_status_check',
        'workspace_memberships_role_check',
        'permission_grants_effect_check',
        'policy_rules_effect_check'
      )`,
    );
    // Until now these lived only in TypeScript, so a repository cast turned a
    // bad column value into a well-typed lie the domain believed.
    expect(rows.rows).toHaveLength(8);
  });

  it('refuses truncating the ledger', async () => {
    // The row trigger never saw a TRUNCATE, and the promise is about the table.
    await expect(handle.db.execute(sql`TRUNCATE events`)).rejects.toThrow();
    const trigger = await handle.db.execute(
      sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'events'::regclass AND tgname = 'events_no_truncate'`,
    );
    expect(trigger.rows).toHaveLength(1);
  });
});

/**
 * What the contracts allow, against what the database accepts.
 *
 * A `CHECK` listing values is the same list as a `z.enum`, written twice. When
 * one of them grows and the other does not, nothing complains until somebody
 * uses the new value in the product and gets `INTERNAL_ERROR` — which is how the
 * `vision` purpose reached `main` unable to be assigned at all: the contract
 * accepted it, the repository passed it through, and the constraint refused it.
 *
 * The values are listed in the other direction, so a value the database refuses
 * is a failure here rather than a bug report later.
 */
const CONSTRAINED: { table: string; column: string; values: readonly string[] }[] = [
  { table: 'actors', column: 'type', values: ActorType.options },
  { table: 'agents', column: 'status', values: AgentStatus.options },
  { table: 'agents', column: 'trust_tier', values: TrustTier.options },
  { table: 'users', column: 'status', values: UserStatus.options },
  { table: 'categories', column: 'status', values: CategoryStatus.options },
  { table: 'workspace_memberships', column: 'role', values: MembershipRole.options },
  { table: 'permission_grants', column: 'effect', values: PermissionEffect.options },
  { table: 'policy_rules', column: 'effect', values: PolicyEffect.options },
  { table: 'ai_providers', column: 'kind', values: AiProviderKind.options },
  { table: 'ai_providers', column: 'origin', values: AiProviderOrigin.options },
  { table: 'ai_assignments', column: 'purpose', values: AiPurpose.options },
  { table: 'sync_sessions', column: 'state', values: SyncSessionState.options },
  { table: 'sync_candidates', column: 'classification', values: SyncClassification.options },
  {
    table: 'sync_candidates',
    column: 'classification_state',
    values: ClassificationState.options,
  },
  { table: 'sync_candidates', column: 'match_reason', values: MatchReason.options },
  { table: 'proposals', column: 'proposal_type', values: ProposalType.options },
  { table: 'proposals', column: 'status', values: ProposalStatus.options },
  { table: 'knowledge_items', column: 'type', values: ItemType.options },
  { table: 'knowledge_items', column: 'review_state', values: ReviewState.options },
  { table: 'knowledge_items', column: 'evidence_state', values: EvidenceState.options },
  { table: 'knowledge_relations', column: 'relation_type', values: RelationType.options },
  { table: 'source_references', column: 'source_type', values: SourceType.options },
  { table: 'revision_sources', column: 'evidence_role', values: EvidenceRole.options },
  { table: 'knowledge_revisions', column: 'change_kind', values: ChangeKind.options },
];

describe('the values a column allows', () => {
  it('are every value the contract allows, because the two lists are one list', async () => {
    const rows = await handle.db.execute<{ table_name: string; def: string }>(
      sql`SELECT c.relname AS table_name, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          WHERE con.contype = 'c'`,
    );

    const missing: string[] = [];
    for (const { table, column, values } of CONSTRAINED) {
      // PostgreSQL rewrites `IN (...)` as `= ANY (ARRAY[...])`, so the check is
      // on the text of the definition rather than on its shape.
      const defs = rows.rows
        .filter((r) => r.table_name === table && r.def.includes(`(${column})::text`))
        .map((r) => r.def)
        .join(' ');
      if (defs === '') {
        missing.push(`${table}.${column} has no CHECK at all`);
        continue;
      }
      for (const value of values) {
        if (!defs.includes(`'${value}'`)) missing.push(`${table}.${column} refuses '${value}'`);
      }
    }
    expect(missing).toEqual([]);
  });
});
