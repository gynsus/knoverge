import { z } from 'zod';

/**
 * A gardening rule, by name.
 *
 * One name per rule, and a rule arrives with its name: this is not a list of
 * what gardening will one day do. ADR 0039 says which rules belong to the core
 * and which need a provider, and a name here means the rule is built.
 */
export const GardeningRuleName = z.enum(['duplicate_content_hash', 'duplicate_text']);
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
  filed: z.number().int().nonnegative(),
  limited: GardeningRuleLimit.nullable(),
});
export type GardeningRuleResult = z.infer<typeof GardeningRuleResult>;

export const GardeningRun = z.object({
  id: z.string(),
  trigger: z.enum(['scheduled', 'requested']),
  started_at: z.iso.datetime(),
  /** Null while it runs, and afterwards for a run a restart interrupted. */
  finished_at: z.iso.datetime().nullable(),
  findings_filed: z.number().int().nonnegative(),
  reached_cap: z.boolean(),
  /** One line, never a body. */
  error: z.string().nullable(),
  rules: z.array(GardeningRuleResult),
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
