import type {
  ActorId,
  CategoryId,
  GardeningRuleName,
  KnowledgeItemId,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';
import type {
  DuplicateHashGroup,
  DuplicateTextPair,
  GardeningNoticeRecord,
  GardeningRepository,
  GardeningRunRecord,
  GardeningSettingsRecord,
  StaleInstructionWindow,
  Tx,
} from '@knoverge/core';
import { TEXT_TITLE_SIMILARITY_THRESHOLD } from '@knoverge/core';
import { and, count, desc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import {
  gardeningRuns,
  gardeningSettings,
  type GardeningNoticeRow,
  type GardeningRuleResultRow,
} from '../schema/gardening.ts';
import { attachments } from '../schema/attachments.ts';
import { categories, categoryAliases } from '../schema/categories.ts';
import {
  knowledgeItemCategories,
  knowledgeItems,
  knowledgeRevisions,
  revisionSources,
  sourceReferences,
} from '../schema/knowledge.ts';
import { proposals } from '../schema/proposals.ts';
import { searchChunks } from '../schema/search.ts';
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
    notices: row.notices.map((notice) => ({
      rule: notice.rule as GardeningRuleName,
      subjectType: notice.subjectType,
      subjectId: notice.subjectId,
      reason: notice.reason,
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
          notices: toNoticeRows(run),
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
          notices: toNoticeRows(run),
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

    async duplicateTexts(workspaceId: WorkspaceId, gardenerActorId: ActorId, maxPairs: number) {
      // `answered` and `current` are what `duplicateContentHashes` means by
      // them, and are here for the same reasons; the comment on that query has
      // them. What is new starts at `indexed`.
      //
      // `indexed` is the lexical index read as one string per item, in chunk
      // order, and only where the chunks were built from the revision the item
      // currently points at — a stale chunk set is text the workspace no longer
      // asserts. `folded` is that string with capitalisation, accents and
      // whitespace set aside, hashed so the group key is short.
      //
      // `survivor` is the oldest of each fold group, and `candidate` pairs
      // every other member against it where the two titles are near enough to
      // be one heading. A pair whose content hashes already match is left to
      // the hash rule: two rules filing one supersession would be one proposal
      // and one conflict.
      //
      // `duplicates` counts the candidates there are rather than the ones
      // coming back, and the window is ordered oldest survivor first, so a
      // capped run reads the oldest mess rather than an arbitrary slice.
      //
      // The equality this groups on is a narrowing and not the decision. What
      // decides is `fold` over the two files, in the rule; loosening this
      // would cost a file read per pair and change no outcome, which is how it
      // should be, because the index is a projection and not authority.
      const rows = await db.execute<{
        duplicates: string | number | null;
        new_item_id: string;
        new_revision_id: string;
        new_content_hash: string;
        new_title: string;
        old_item_id: string;
        old_revision_id: string;
        old_content_hash: string;
        old_title: string;
        new_created_at: Date;
        old_created_at: Date;
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
            and i.status = 'active'
            and not exists (select 1 from answered as a where a.item_id = i.id)
        ),
        indexed as (
          select s.knowledge_item_id as item_id, s.revision_id as revision_id,
                 string_agg(s.text, ' ' order by s.ordinal) as text
          from ${searchChunks} as s
          -- The workspace is named twice in this statement, here and in the
          -- current CTE, and either one alone would scope it. Both stay: this
          -- one stops the aggregate running over every installation's chunks
          -- before the join throws them away, and the other is where the scope
          -- is a rule rather than a cost. No test can tell them apart, which
          -- is why this says so.
          where s.workspace_id = ${workspaceId}
          group by s.knowledge_item_id, s.revision_id
        ),
        folded as (
          select c.*,
                 -- The backslash is doubled because this is a template
                 -- literal: a single one is not an escape JavaScript knows, so
                 -- PostgreSQL would be handed the letter s and would collapse
                 -- runs of that instead of runs of whitespace. A test caught
                 -- this, which is the only thing that could have.
                 md5(btrim(regexp_replace(lower(unaccent(x.text)), '\\s+', ' ', 'g'))) as body_key
          from current as c
          join indexed as x on x.item_id = c.item_id and x.revision_id = c.revision_id
        ),
        grouped as (
          select body_key from folded group by body_key having count(*) > 1
        ),
        survivor as (
          select distinct on (f.body_key)
                 f.body_key, f.item_id, f.revision_id, f.content_hash, f.title, f.created_at
          from folded as f join grouped as g on g.body_key = f.body_key
          order by f.body_key, f.created_at asc, f.item_id asc
        ),
        candidate as (
          select s.item_id as new_item_id, s.revision_id as new_revision_id,
                 s.content_hash as new_content_hash, s.title as new_title,
                 s.created_at as new_created_at,
                 f.item_id as old_item_id, f.revision_id as old_revision_id,
                 f.content_hash as old_content_hash, f.title as old_title,
                 f.created_at as old_created_at
          from folded as f
          join survivor as s on s.body_key = f.body_key
          where f.item_id <> s.item_id
            and f.content_hash <> s.content_hash
            and similarity(unaccent(lower(f.title)), unaccent(lower(s.title)))
                >= ${TEXT_TITLE_SIMILARITY_THRESHOLD}
        )
        select (select count(*) from candidate) as duplicates, c.*
        from candidate as c
        order by c.new_created_at asc, c.old_created_at asc, c.old_item_id asc
        limit ${maxPairs}
      `);

      // What the rule read: the items whose text it could compare. Equal to
      // the active count in a workspace whose index is complete, and lower in
      // one waiting for `knoverge db reindex` — which is worth seeing on the
      // screen rather than hiding behind a number that is always the same.
      const [counted] = await db
        .select({ examined: count() })
        .from(knowledgeItems)
        .innerJoin(
          searchChunks,
          and(
            eq(searchChunks.knowledgeItemId, knowledgeItems.id),
            eq(searchChunks.revisionId, knowledgeItems.currentRevisionId),
            eq(searchChunks.ordinal, 0),
          ),
        )
        .where(
          and(eq(knowledgeItems.workspaceId, workspaceId), eq(knowledgeItems.status, 'active')),
        );

      let duplicates = 0;
      const pairs: DuplicateTextPair[] = [];
      for (const row of rows.rows ?? []) {
        duplicates = Number(row.duplicates ?? 0);
        pairs.push({
          survivor: {
            itemId: row.new_item_id as KnowledgeItemId,
            revisionId: row.new_revision_id as RevisionId,
            contentHash: row.new_content_hash,
            title: row.new_title,
            createdAt: new Date(row.new_created_at),
          },
          copy: {
            itemId: row.old_item_id as KnowledgeItemId,
            revisionId: row.old_revision_id as RevisionId,
            contentHash: row.old_content_hash,
            title: row.old_title,
            createdAt: new Date(row.old_created_at),
          },
        });
      }
      return { examined: counted?.examined ?? 0, duplicates, pairs };
    },

    async orphanSources(workspaceId: WorkspaceId, max: number) {
      // Nothing ever rested on these: a row written and never attached. Not a
      // source cited only by an older revision, which is the ordinary state of
      // every edited item's history, and not one cited only by a deleted item,
      // which is the history of knowledge somebody removed on purpose. Both of
      // those still have a revision citing them, and this asks for none.
      //
      // Attachment sources are left out because orphan_attachment can say
      // something about the bytes rather than about the row pointing at them,
      // and two notices about one file would be two readings of one fact.
      const rows = await db.execute<{
        found: string | number | null;
        id: string;
        source_type: string;
        uri: string | null;
        external_system: string | null;
        external_key: string | null;
        created_at: Date;
      }>(sql`
        with orphan as (
          select s.id, s.source_type, s.uri, s.external_system, s.external_key, s.created_at
          from ${sourceReferences} as s
          where s.workspace_id = ${workspaceId}
            and s.source_type <> 'attachment'
            and not exists (
              select 1 from ${revisionSources} as rs where rs.source_reference_id = s.id
            )
        )
        select (select count(*) from orphan) as found,
               o.id, o.source_type, o.uri, o.external_system, o.external_key, o.created_at
        from orphan as o
        order by o.created_at asc, o.id asc
        limit ${max}
      `);

      // The same filter as the scan, because this is what the rule looked at:
      // counting the attachment sources it never considers would make a
      // workspace full of files look like one full of unread evidence.
      const [counted] = await db
        .select({ examined: count() })
        .from(sourceReferences)
        .where(
          and(
            eq(sourceReferences.workspaceId, workspaceId),
            ne(sourceReferences.sourceType, 'attachment'),
          ),
        );

      let found = 0;
      const sources = (rows.rows ?? []).map((row) => {
        found = Number(row.found ?? 0);
        return {
          sourceReferenceId: row.id,
          sourceType: row.source_type,
          // What identifies it to a reader: the address, or the record in
          // another system, or nothing — a person having said something is its
          // own occurrence and has neither.
          label:
            row.uri ??
            (row.external_system === null || row.external_key === null
              ? null
              : `${row.external_system} ${row.external_key}`),
          createdAt: new Date(row.created_at),
        };
      });
      return { examined: counted?.examined ?? 0, found, sources };
    },

    async orphanAttachments(workspaceId: WorkspaceId, max: number) {
      // `made` is every item ever made from each file, reached the only way
      // there is: the source reference naming the attachment, the revision
      // citing that source, and the item that revision belongs to. Distinct,
      // because an item that cites the file at three revisions is one item.
      //
      // `orphan` keeps the files where every one of those items is deleted —
      // ADR 0039's own wording. A file whose item was superseded is not one:
      // superseded knowledge is still knowledge and the file is still what it
      // rested on. A file nothing was ever made from is not one either: it is
      // waiting to be read or is one this installation cannot read, and the
      // files screen says both of those itself.
      const rows = await db.execute<{
        found: string | number | null;
        id: string;
        filename: string;
        size_bytes: string | number;
        items: string | number;
      }>(sql`
        with made as (
          select distinct a.id as attachment_id, i.id as item_id, i.status as status
          from ${attachments} as a
          join ${sourceReferences} as s
            on s.attachment_id = a.id and s.workspace_id = a.workspace_id
          join ${revisionSources} as rs on rs.source_reference_id = s.id
          join ${knowledgeRevisions} as r on r.id = rs.revision_id
          join ${knowledgeItems} as i on i.id = r.knowledge_item_id
          where a.workspace_id = ${workspaceId}
        ),
        orphan as (
          select m.attachment_id, count(*) as items
          from made as m
          group by m.attachment_id
          having bool_and(m.status = 'deleted')
        )
        select (select count(*) from orphan) as found,
               a.id, a.filename, a.size_bytes, o.items
        from orphan as o
        join ${attachments} as a on a.id = o.attachment_id
        order by a.created_at asc, a.id asc
        limit ${max}
      `);

      const [counted] = await db
        .select({ examined: count() })
        .from(attachments)
        .where(eq(attachments.workspaceId, workspaceId));

      let found = 0;
      const found_attachments = (rows.rows ?? []).map((row) => {
        found = Number(row.found ?? 0);
        return {
          attachmentId: row.id,
          filename: row.filename,
          sizeBytes: Number(row.size_bytes),
          deletedItems: Number(row.items),
        };
      });
      return { examined: counted?.examined ?? 0, found, attachments: found_attachments };
    },

    async weakProvenance(workspaceId: WorkspaceId, max: number) {
      // Two counts and a window. The counts come separately because they are
      // the answer even when the window is empty: a workspace where everything
      // cites a source has still been read, and so has one where nothing does.
      //
      // `current_revision_id is not null` is an item mid-write, between the
      // insert and the revision it will point at. Counting it would make the
      // workspace's habit depend on a transaction in flight.
      const [counted] =
        (
          await db.execute<{ examined: string | number; cited: string | number }>(sql`
          select count(*) as examined,
                 count(*) filter (
                   where exists (
                     select 1 from ${revisionSources} as rs
                     where rs.revision_id = i.current_revision_id
                   )
                 ) as cited
          from ${knowledgeItems} as i
          where i.workspace_id = ${workspaceId}
            and i.status = 'active'
            and i.current_revision_id is not null
        `)
        ).rows ?? [];

      // The current revision rather than any of them: an item whose first
      // revision cited a page and whose current one dropped it asserts the
      // thing without the page now, and the history is where the page went.
      const rows = await db.execute<{
        item_id: string;
        type: string;
        title: string;
        created_at: Date;
      }>(sql`
        select i.id as item_id, i.type as type, r.title as title, i.created_at as created_at
        from ${knowledgeItems} as i
        join ${knowledgeRevisions} as r on r.id = i.current_revision_id
        where i.workspace_id = ${workspaceId}
          and i.status = 'active'
          and not exists (
            select 1 from ${revisionSources} as rs where rs.revision_id = r.id
          )
        order by i.created_at asc, i.id asc
        limit ${max}
      `);

      return {
        examined: Number(counted?.examined ?? 0),
        cited: Number(counted?.cited ?? 0),
        items: (rows.rows ?? []).map((row) => ({
          itemId: row.item_id as KnowledgeItemId,
          title: row.title,
          type: row.type,
          createdAt: new Date(row.created_at),
        })),
      };
    },

    async staleInstructions(workspaceId: WorkspaceId, window: StaleInstructionWindow, max: number) {
      // Either way an instruction can run out: the date it gave itself has
      // passed, or nobody has touched it for long enough to put it in doubt.
      // Both dates arrive from the caller, because how long is long enough is a
      // domain decision and `now()` here could not be tested at a chosen
      // moment.
      //
      // `least` orders by the older of the two dates, so the oldest neglect
      // comes first and a capped run reads that rather than an arbitrary slice.
      // An instruction with no end date has none to compare, which is what
      // infinity is for.
      const rows = await db.execute<{
        found: string | number | null;
        item_id: string;
        title: string;
        valid_until: Date | null;
        revised_at: Date;
      }>(sql`
        with candidate as (
          select i.id as item_id, r.title as title,
                 i.valid_until as valid_until, r.created_at as revised_at
          from ${knowledgeItems} as i
          join ${knowledgeRevisions} as r on r.id = i.current_revision_id
          where i.workspace_id = ${workspaceId}
            and i.status = 'active'
            and i.type = 'instruction'
            and (
              i.valid_until <= ${window.now}
              or r.created_at < ${window.untouchedBefore}
            )
        )
        select (select count(*) from candidate) as found,
               c.item_id, c.title, c.valid_until, c.revised_at
        from candidate as c
        order by least(coalesce(c.valid_until, 'infinity'::timestamptz), c.revised_at) asc,
                 c.item_id asc
        limit ${max}
      `);

      // Every active instruction, which is what the rule read. A workspace with
      // no instructions at all reads zero, and that is the honest answer rather
      // than a rule that looks as though it found nothing among many.
      const [counted] = await db
        .select({ examined: count() })
        .from(knowledgeItems)
        .where(
          and(
            eq(knowledgeItems.workspaceId, workspaceId),
            eq(knowledgeItems.status, 'active'),
            eq(knowledgeItems.type, 'instruction'),
          ),
        );

      let found = 0;
      const instructions = (rows.rows ?? []).map((row) => {
        found = Number(row.found ?? 0);
        return {
          itemId: row.item_id as KnowledgeItemId,
          title: row.title,
          validUntil: row.valid_until === null ? null : new Date(row.valid_until),
          revisedAt: new Date(row.revised_at),
        };
      });
      return { examined: counted?.examined ?? 0, found, instructions };
    },

    async emptyCategories(workspaceId: WorkspaceId, createdBefore: Date, max: number) {
      // No items at all rather than no active ones: the item key is `restrict`,
      // so a category whose only items are deleted cannot be removed, and a
      // notice calling it empty would be asking for something the installation
      // refuses (ADR 0025).
      //
      // Children of any status, because a child row is a child. A category with
      // an archived one under it is still a branch.
      const rows = await db.execute<{
        found: string | number | null;
        id: string;
        path: string;
        name: string;
        created_at: Date;
      }>(sql`
        with candidate as (
          select c.id as id, c.path as path, c.name as name, c.created_at as created_at
          from ${categories} as c
          where c.workspace_id = ${workspaceId}
            and c.status = 'active'
            and c.created_at < ${createdBefore}
            and not exists (
              select 1 from ${knowledgeItemCategories} as kic where kic.category_id = c.id
            )
            and not exists (
              select 1 from ${categories} as child where child.parent_id = c.id
            )
        )
        select (select count(*) from candidate) as found,
               q.id, q.path, q.name, q.created_at
        from candidate as q
        order by q.created_at asc, q.id asc
        limit ${max}
      `);

      // Every active category, which is what the rule read. The ones inside the
      // grace period are read and left alone, and a workspace whose taxonomy is
      // all a week old should still report what it looked at.
      const [counted] = await db
        .select({ examined: count() })
        .from(categories)
        .where(and(eq(categories.workspaceId, workspaceId), eq(categories.status, 'active')));

      let found = 0;
      const empty = (rows.rows ?? []).map((row) => {
        found = Number(row.found ?? 0);
        return {
          categoryId: row.id as CategoryId,
          path: row.path,
          name: row.name,
          createdAt: new Date(row.created_at),
        };
      });
      return { examined: counted?.examined ?? 0, found, categories: empty };
    },

    async danglingAliases(workspaceId: WorkspaceId, max: number) {
      // Pointing nowhere means pointing at a category nothing can be filed in,
      // because the foreign key makes a missing row impossible. `proposed` is
      // left out: that alias is reserved for a review waiting to happen.
      //
      // The join is on the category id and the workspace both. The alias row
      // carries its own workspace, and the two agreeing is what the scope rests
      // on.
      const rows = await db.execute<{
        found: string | number | null;
        id: string;
        alias: string;
        category_id: string;
        path: string;
        status: string;
        created_at: Date;
      }>(sql`
        with candidate as (
          select a.id as id, a.alias as alias, a.created_at as created_at,
                 c.id as category_id, c.path as path, c.status as status
          from ${categoryAliases} as a
          join ${categories} as c
            on c.id = a.category_id and c.workspace_id = a.workspace_id
          where a.workspace_id = ${workspaceId}
            and c.status not in ('active', 'proposed')
        )
        select (select count(*) from candidate) as found,
               q.id, q.alias, q.category_id, q.path, q.status, q.created_at
        from candidate as q
        order by q.created_at asc, q.id asc
        limit ${max}
      `);

      // Every alias in the workspace, which is what the rule read.
      const [counted] = await db
        .select({ examined: count() })
        .from(categoryAliases)
        .where(eq(categoryAliases.workspaceId, workspaceId));

      let found = 0;
      const dangling = (rows.rows ?? []).map((row) => {
        found = Number(row.found ?? 0);
        return {
          aliasId: row.id,
          alias: row.alias,
          categoryId: row.category_id as CategoryId,
          path: row.path,
          status: row.status,
          createdAt: new Date(row.created_at),
        };
      });
      return { examined: counted?.examined ?? 0, found, aliases: dangling };
    },
  };
}

/** The run's notices, in the shape the column holds. */
function toNoticeRows(run: GardeningRunRecord): GardeningNoticeRow[] {
  return run.notices.map((notice: GardeningNoticeRecord) => ({
    rule: notice.rule,
    subjectType: notice.subjectType,
    subjectId: notice.subjectId,
    reason: notice.reason,
  }));
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
