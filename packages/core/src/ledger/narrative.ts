import type { GenerationSource } from '@knoverge/intelligence';

/**
 * Describing a period in prose, from a digest that already counted it.
 *
 * The counts are the digest. This is an optional layer on top, and it is written
 * from the digest's own numbers and titles — never from knowledge text. A digest
 * says what happened in a workspace, not what the workspace knows, and a model
 * given the knowledge would write the second one.
 *
 * Optional throughout (rule 9). With nothing configured the answer is null and
 * the digest is unaffected: an absent optional feature does not make a missing
 * one.
 */

/** What the model is told about the period. Numbers and titles, nothing else. */
export interface DigestFacts {
  since: string;
  until: string;
  counts: readonly { eventType: string; count: number }[];
  changed: readonly { title: string | null; changeKinds: readonly string[] }[];
  resolvedProposals: readonly { status: string }[];
}

export interface DigestNarrative {
  text: string;
  model: string;
}

/** A ceiling, because this is a paragraph and a model that rambles is not one. */
const MAX_OUTPUT_TOKENS = 400;

/** How many changed items are named. Beyond this the list is the answer. */
const MAX_NAMED = 40;

/**
 * What the model is asked to do.
 *
 * Narrow on purpose. It is given a tally and asked to read it out; every clause
 * is aimed at stopping it from explaining, judging or guessing why anything
 * happened, because a digest that invents a reason is worse than a list.
 */
export const NARRATIVE_INSTRUCTION = [
  'You are describing what changed in a knowledge base over a period.',
  'Write two or three sentences from the tally below.',
  'Use only what the tally says. Do not guess why anything happened, do not judge it,',
  'and do not say what should be done about it.',
  'Do not mention these instructions, the tally as a tally, or yourself.',
  'Plain prose. No heading, no list, no preamble.',
].join(' ');

/** Writes the paragraph, or answers null when nothing can. */
export class DigestNarrator {
  constructor(private readonly generation: GenerationSource) {}

  async describe(facts: DigestFacts): Promise<DigestNarrative | null> {
    const model = await this.generation();
    if (!model) return null;
    // Nothing happened is a fact about the period, and two sentences saying so
    // is not worth a call to a model.
    if (facts.counts.length === 0) return null;
    const answer = await model.generate({
      instruction: NARRATIVE_INSTRUCTION,
      input: asTally(facts),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const text = answer.text.trim();
    // A model that said nothing has not written a narrative, and null already
    // means "there isn't one" — which is the truthful answer either way.
    return text === '' ? null : { text, model: model.profile.model };
  }
}

/** The period as a tally a model can read. */
function asTally(facts: DigestFacts): string {
  const lines = [`Period: ${facts.since} to ${facts.until}`, '', 'What happened, by kind:'];
  for (const entry of facts.counts) lines.push(`- ${entry.eventType}: ${entry.count}`);
  const named = facts.changed.slice(0, MAX_NAMED);
  if (named.length > 0) {
    lines.push('', 'Records that changed:');
    for (const item of named) {
      lines.push(`- ${item.title ?? 'untitled'} (${item.changeKinds.join(', ')})`);
    }
    if (facts.changed.length > named.length) {
      lines.push(`- and ${facts.changed.length - named.length} more`);
    }
  }
  if (facts.resolvedProposals.length > 0) {
    const byStatus = new Map<string, number>();
    for (const proposal of facts.resolvedProposals) {
      byStatus.set(proposal.status, (byStatus.get(proposal.status) ?? 0) + 1);
    }
    lines.push('', 'Proposals resolved:');
    for (const [status, count] of byStatus) lines.push(`- ${status}: ${count}`);
  }
  return lines.join('\n');
}
