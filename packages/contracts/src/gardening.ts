import { z } from 'zod';

/**
 * A gardening rule, by name.
 *
 * One name per rule, and a rule arrives with its name: this is not a list of
 * what gardening will one day do. ADR 0039 says which rules belong to the core
 * and which need a provider, and a name here means the rule is built.
 */
export const GardeningRuleName = z.enum([
  'duplicate_content_hash',
  'duplicate_text',
  'orphan_source',
  'orphan_attachment',
]);
export type GardeningRuleName = z.infer<typeof GardeningRuleName>;

/** How often a run is taken. Hours, because a schedule is read in hours. */
export const GardeningIntervalHours = z
  .number()
  .int()
  .min(1)
  .max(24 * 7);

/**
 * What one run, or one rule inside it, may leave in the review queue.
 *
 * A cap rather than a rate: what matters is how much of the queue belongs to
 * the gardener while a person is reading it, and the proposals from people and
 * agents are the ones somebody is waiting on.
 */
export const GardeningFindingCap = z.number().int().min(1).max(500);

export const GardeningSettings = z.object({
  enabled: z.boolean(),
  interval_hours: GardeningIntervalHours,
  max_findings_per_run: GardeningFindingCap,
  max_findings_per_rule: GardeningFindingCap,
  last_run_at: z.iso.datetime().nullable(),
  /** Every rule this installation has, whether or not it ran. */
  rules: z.array(GardeningRuleName),
});
export type GardeningSettings = z.infer<typeof GardeningSettings>;

export const SaveGardeningSettingsRequest = z.object({
  enabled: z.boolean(),
  interval_hours: GardeningIntervalHours.default(24),
  max_findings_per_run: GardeningFindingCap.default(50),
  max_findings_per_rule: GardeningFindingCap.default(20),
});
export type SaveGardeningSettingsRequest = z.infer<typeof SaveGardeningSettingsRequest>;

export const GardeningSettingsResponse = z.object({ settings: GardeningSettings });
export type GardeningSettingsResponse = z.infer<typeof GardeningSettingsResponse>;

/**
 * Why a rule filed less than it found, or did not run at all.
 *
 * `run_cap` is the run having filed as much as it may, which is also why a rule
 * can report nothing examined; `rule_cap` is this rule's own share of it.
 */
export const GardeningRuleLimit = z.enum(['run_cap', 'rule_cap']);
export type GardeningRuleLimit = z.infer<typeof GardeningRuleLimit>;

/**
 * One rule's share of a run.
 *
 * `examined` and `found` are reported even when nothing was filed, because a
 * rule that read a thousand items and found nothing is the answer somebody
 * wants, and it is not the same answer as a rule that never ran.
 */
export const GardeningRuleResult = z.object({
  rule: GardeningRuleName,
  examined: z.number().int().nonnegative(),
  found: z.number().int().nonnegative(),
  /**
   * How many of them this run recorded: proposals for a rule that names writes,
   * notices for one that does not. One number, because from the screen's side
   * it is one question — how much of what it found did it get down.
   */
  filed: z.number().int().nonnegative(),
  limited: GardeningRuleLimit.nullable(),
});
export type GardeningRuleResult = z.infer<typeof GardeningRuleResult>;

/**
 * What kind of thing a notice is about, so a reader knows where to look.
 *
 * Two, because two rules produce notices. The rules that will notice an item or
 * a category are not built, and a name here would be a promise rather than a
 * thing the server can send — the same standard the rule names are held to.
 *
 * Neither of these has a screen that could fix it. That is said on the notice
 * rather than hidden by leaving the notice out (ADR 0043).
 */
export const GardeningNoticeSubject = z.enum(['source_reference', 'attachment']);
export type GardeningNoticeSubject = z.infer<typeof GardeningNoticeSubject>;

/**
 * One thing a rule saw that names no write (ADR 0043).
 *
 * A proposal is what a finding becomes when somebody could approve it. These
 * are the rest: a source reference no revision cites, an attachment whose every
 * item is gone. There is nothing to approve and nothing to dismiss — a notice is
 * true until the thing it describes is fixed, and then it stops being reported.
 */
export const GardeningNotice = z.object({
  rule: GardeningRuleName,
  subject_type: GardeningNoticeSubject,
  subject_id: z.string(),
  /** English, like a proposal's reason, and for the same reason. */
  reason: z.string(),
});
export type GardeningNotice = z.infer<typeof GardeningNotice>;

export const GardeningRun = z.object({
  id: z.string(),
  trigger: z.enum(['scheduled', 'requested']),
  started_at: z.iso.datetime(),
  /** Null while it runs, and afterwards for a run a restart interrupted. */
  finished_at: z.iso.datetime().nullable(),
  /** Proposals left in the review queue. A notice is not one of them. */
  findings_filed: z.number().int().nonnegative(),
  reached_cap: z.boolean(),
  /** One line, never a body. */
  error: z.string().nullable(),
  rules: z.array(GardeningRuleResult),
  /** What the run saw that named no write. Capped per rule, never per run. */
  notices: z.array(GardeningNotice),
});
export type GardeningRun = z.infer<typeof GardeningRun>;

export const GardeningRunsResponse = z.object({ runs: z.array(GardeningRun) });
export type GardeningRunsResponse = z.infer<typeof GardeningRunsResponse>;

/**
 * What running it now did.
 *
 * The settings come with it because a run changes `last_run_at`, and a screen
 * that showed the run without it would disagree with itself until reloaded.
 */
export const RunGardeningResponse = z.object({
  run: GardeningRun,
  settings: GardeningSettings,
});
export type RunGardeningResponse = z.infer<typeof RunGardeningResponse>;
