import type {
  ActorId,
  GardeningRuleName,
  KnowledgeItemId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';
import type {
  DuplicateHashGroup,
  GardeningRepository,
  GardeningRunRecord,
  GardeningSettingsRecord,
  Tx,
} from '@knoverge/core';
import { and, count, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import {
  gardeningRuns,
  gardeningSettings,
  type GardeningRuleResultRow,
} from '../schema/gardening.ts';
import { knowledgeItems, knowledgeRevisions } from '../schema/knowledge.ts';
import { proposals } from '../schema/proposals.ts';
import { asTx } from '../unit-of-work.ts';

/**
 * What a workspace with no row has.
 *
 * The same numbers as the column defaults, and they have to stay the same:
 * these are what the screen shows before anybody saves, and the defaults are
 * what the row gets when they do.
 */
const DEFAULTS = {
  enabled: false,
  intervalHours: 24,
  maxFindingsPerRun: 50,
  maxFindingsPerRule: 20,
} as const;

function toSettings(row: typeof gardeningSettings.$inferSelect): GardeningSettingsRecord {
  return {
    workspaceId: row.workspaceId as WorkspaceId,
    enabled: row.enabled,
    intervalHours: row.intervalHours,
    maxFindingsPerRun: row.maxFindingsPerRun,
    maxFindingsPerRule: row.maxFindingsPerRule,
    lastRunAt: row.lastRunAt,
    updatedAt: row.updatedAt,
  };
}

function toRun(row: typeof gardeningRuns.$inferSelect): GardeningRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId as WorkspaceId,
    trigger: row.trigger as 'scheduled' | 'requested',
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    findingsFiled: row.findingsFiled,
    reachedCap: row.reachedCap,
    error: row.error,
    rules: row.rules.map((rule) => ({
      rule: rule.rule as GardeningRuleName,
      examined: rule.examined,
      found: rule.found,
      filed: rule.filed,
      limited: rule.limited,
    })),
  };
}

export function createGardeningRepository(db: Database): GardeningRepository {
  return {
    async settings(workspaceId: WorkspaceId) {
      const [row] = await db
        .select()
        .from(gardeningSettings)
        .where(eq(gardeningSettings.workspaceId, workspaceId))
        .limit(1);
      // No row is a workspace nobody has configured, which is gardening off.
      // Unlike the backup settings, which the migration inserts and whose
      // absence is a fault: there is one of those and one per workspace of
      // these, and backfilling every workspace would be a thing workspace
      // creation and import both had to remember.
      return row
        ? toSettings(row)
        : {
            workspaceId,
            ...DEFAULTS,
            lastRunAt: null,
            updatedAt: new Date(0),
          };
    },

    async save(tx: Tx, workspaceId: WorkspaceId, patch, at: Date) {
      const values = {
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.intervalHours === undefined ? {} : { intervalHours: patch.intervalHours }),
        ...(patch.maxFindingsPerRun === undefined
          ? {}
          : { maxFindingsPerRun: patch.maxFindingsPerRun }),
        ...(patch.maxFindingsPerRule === undefined
          ? {}
          : { maxFindingsPerRule: patch.maxFindingsPerRule }),
        ...(patch.lastRunAt === undefined ? {} : { lastRunAt: patch.lastRunAt }),
      };
      // Upsert, because the row's job is to hold what somebody changed: a run
      // recording when it ran creates it as readily as a person changing the
      // schedule, and both leave the columns they said nothing about alone.
      await asTx(tx)
        .insert(gardeningSettings)
        .values({ workspaceId, ...DEFAULTS, ...values, updatedAt: at })
        .onConflictDoUpdate({
          target: gardeningSettings.workspaceId,
          set: { ...values, updatedAt: at },
        });
    },

    async insertRun(tx: Tx, run: GardeningRunRecord) {
      await asTx(tx)
        .insert(gardeningRuns)
        .values({
          id: run.id,
          workspaceId: run.workspaceId,
          trigger: run.trigger,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          findingsFiled: run.findingsFiled,
          reachedCap: run.reachedCap,
          error: run.error,
          rules: toRuleRows(run),
        });
    },

    async finishRun(tx: Tx, run: GardeningRunRecord) {
      await asTx(tx)
        .update(gardeningRuns)
        .set({
          finishedAt: run.finishedAt,
          findingsFiled: run.findingsFiled,
          reachedCap: run.reachedCap,
          error: run.error,
          rules: toRuleRows(run),
        })
        .where(and(eq(gardeningRuns.workspaceId, run.workspaceId), eq(gardeningRuns.id, run.id)));
    },

    async runs(workspaceId: WorkspaceId, limit: number) {
      const rows = await db
        .select()
        .from(gardeningRuns)
        .where(eq(gardeningRuns.workspaceId, workspaceId))
        .orderBy(desc(gardeningRuns.startedAt))
        .limit(limit);
      return rows.map(toRun);
    },

    async due(now: Date) {
      // The interval is a setting, so the question is asked of the database
      // rather than of a scheduler: enabled, and nothing taken within it. A
      // workspace that has never run is due immediately, which is what turning
      // gardening on should do.
      const rows = await db
        .select({ workspaceId: gardeningSettings.workspaceId })
        .from(gardeningSettings)
        .where(
          and(
            eq(gardeningSettings.enabled, true),
            or(
              isNull(gardeningSettings.lastRunAt),
              lte(
                gardeningSettings.lastRunAt,
                sql`${now}::timestamptz - make_interval(hours => ${gardeningSettings.intervalHours})`,
              ),
            ),
          ),
        );
      return rows.map((row) => row.workspaceId as WorkspaceId);
    },

    async duplicateContentHashes(
      workspaceId: WorkspaceId,
      gardenerActorId: ActorId,
      maxGroups: number,
    ) {
      // One statement, and every part of it is there for a different reason.
      //
      // `answered` is what must not be filed about again: an item with a
      // proposal waiting, and an item whose gardening proposal this actor filed
      // was rejected. It is excluded here rather than from the result, because
      // a cap takes the oldest groups first and the answered items are the
      // oldest — filtering afterwards would mean a workspace with one refused
      // duplicate files nothing ever again.
      //
      // `current` is what the workspace asserts and nobody is discussing, with
      // the hash each item currently holds, reached through the primary key of
      // the revision the item points at. `dup` is the hashes more than one of
      // them holds. `totals` counts the findings there are rather than the ones
      // coming back, because a rule has to be able to report that it found more
      // than it may file. And the groups come back oldest first, so what a
      // capped run files is the oldest mess rather than an arbitrary slice.
      const rows = await db.execute<{
        content_hash: string;
        item_id: string;
        revision_id: string;
        title: string;
        created_at: Date;
        duplicates: string | number | null;
      }>(sql`
        with answered as (
          select distinct p.target_item_id as item_id
          from ${proposals} as p
          where p.workspace_id = ${workspaceId}
            and p.target_item_id is not null
            and (
              p.status in ('pending', 'conflict')
              or (p.status = 'rejected' and p.proposed_by_actor_id = ${gardenerActorId})
            )
        ),
        current as (
          select i.id as item_id, i.created_at as created_at,
                 r.id as revision_id, r.content_hash as content_hash, r.title as title
          from ${knowledgeItems} as i
          join ${knowledgeRevisions} as r on r.id = i.current_revision_id
          where i.workspace_id = ${workspaceId}
            -- Only what the workspace currently asserts. A superseded or
            -- deleted item saying the same thing is history, and proposing to
            -- supersede it again would be proposing nothing.
            and i.status = 'active'
            and not exists (select 1 from answered as a where a.item_id = i.id)
        ),
        dup as (
          select content_hash, count(*) as n, min(created_at) as oldest
          from current group by content_hash having count(*) > 1
        ),
        totals as (
          select (select sum(n - 1) from dup) as duplicates
        ),
        chosen as (
          select content_hash from dup order by oldest asc, content_hash asc limit ${maxGroups}
        )
        select c.content_hash, c.item_id, c.revision_id, c.title, c.created_at, t.duplicates
        from current as c
        join chosen as ch on ch.content_hash = c.content_hash
        cross join totals as t
        order by c.content_hash asc, c.created_at asc, c.item_id asc
      `);

      // Separately, and counting everything active: this is what the screen
      // shows as read, and a rule that found nothing still read the workspace.
      const [counted] = await db
        .select({ examined: count() })
        .from(knowledgeItems)
        .where(
          and(eq(knowledgeItems.workspaceId, workspaceId), eq(knowledgeItems.status, 'active')),
        );

      const groups = new Map<string, DuplicateHashGroup>();
      let duplicates = 0;
      for (const row of rows.rows ?? []) {
        duplicates = Number(row.duplicates ?? 0);
        const group = groups.get(row.content_hash) ?? {
          contentHash: row.content_hash,
          members: [],
        };
        group.members.push({
          itemId: row.item_id as KnowledgeItemId,
          revisionId: row.revision_id as RevisionId,
          contentHash: row.content_hash,
          title: row.title,
          createdAt: new Date(row.created_at),
        });
        groups.set(row.content_hash, group);
      }
      return { examined: counted?.examined ?? 0, duplicates, groups: [...groups.values()] };
    },
  };
}

/** The run's rule results, in the shape the column holds. */
function toRuleRows(run: GardeningRunRecord): GardeningRuleResultRow[] {
  return run.rules.map((rule) => ({
    rule: rule.rule,
    examined: rule.examined,
    found: rule.found,
    filed: rule.filed,
    limited: rule.limited,
  }));
}
