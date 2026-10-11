import { boolean, index, integer, jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';

import { id, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

/**
 * Whether this workspace tidies itself, and how much it may file (ADR 0042).
 *
 * Per workspace, unlike the backup settings: a workspace is the unit of
 * knowledge and of review, so it is the unit of tidying, and the review queue
 * a flood would ruin belongs to a workspace rather than to the installation.
 *
 * A workspace with no row has the defaults. The row appears when somebody
 * changes something, so neither workspace creation nor import has to remember
 * to make one.
 */
export const gardeningSettings = pgTable('gardening_settings', {
  workspaceId: id('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Off until somebody turns it on: gardening makes work for people. */
  enabled: boolean('enabled').notNull().default(false),
  intervalHours: integer('interval_hours').notNull().default(24),
  /**
   * What one run and one rule may leave in the review queue.
   *
   * A gardener that buries the queue has done harm, not work. A rule that would
   * exceed its cap reports the count instead of filing the rest, and the next
   * run finds the rest again.
   */
  maxFindingsPerRun: integer('max_findings_per_run').notNull().default(50),
  maxFindingsPerRule: integer('max_findings_per_rule').notNull().default(20),
  lastRunAt: timestampTz('last_run_at'),
  updatedAt: timestampTz('updated_at').notNull(),
});

/** One rule's share of a run, as the screen reads it. */
export interface GardeningRuleResultRow {
  rule: string;
  /** How much the rule looked at, in whatever it counts. */
  examined: number;
  /** How many findings it has, which may be more than it was allowed to file. */
  found: number;
  filed: number;
  /**
   * Why it filed less than it found, or did not run at all.
   *
   * One field rather than two, because from the screen's side they are one
   * question: a rule that filed nothing because the run was full and a rule
   * that filed twenty of thirty are both "held back", and the difference is in
   * the numbers beside it.
   */
  limited: 'run_cap' | 'rule_cap' | null;
}

/**
 * What a run did.
 *
 * The findings themselves are proposals and live in the review queue; this row
 * is the run, which is how the screen tells a rule that found nothing from a
 * rule that never ran.
 */
export const gardeningRuns = pgTable(
  'gardening_runs',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** `scheduled` or `requested`. */
    trigger: varchar('trigger', { length: 16 }).notNull(),
    startedAt: timestampTz('started_at').notNull(),
    /** Null while it runs, and afterwards for a run a restart interrupted. */
    finishedAt: timestampTz('finished_at'),
    findingsFiled: integer('findings_filed').notNull().default(0),
    reachedCap: boolean('reached_cap').notNull().default(false),
    /** One line, never a body. */
    error: varchar('error', { length: 500 }),
    rules: jsonb('rules').$type<GardeningRuleResultRow[]>().notNull().default([]),
  },
  (t) => [index('gardening_runs_workspace_idx').on(t.workspaceId, t.startedAt.desc())],
);
