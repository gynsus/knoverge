import type { EvidenceState, Frontmatter, FrontmatterSource } from '@knoverge/contracts';
import { FRONTMATTER_KEY_ORDER, canonicalTag, normaliseTag } from '@knoverge/contracts';

/**
 * What a claim rests on, from the sources it cites (KNOWLEDGE_MODEL.md §8).
 *
 * `source_backed` needs a source somebody else could check: a locator, or a
 * fingerprint of the bytes. A source with neither is an assertion about where
 * something came from, not evidence of it.
 *
 * `corroborated` needs two of those from different origins. Counting entries
 * would announce independent corroboration for an agent that cited three
 * sections of one document, which is the most likely way to reach the value at
 * all; counting origins refuses that case. ADR 0026 records the rule and what it
 * does and does not claim.
 */
export function evidenceFrom(sources: readonly FrontmatterSource[]): EvidenceState {
  const origins = new Set(sources.filter(corroborates).map(originOf));
  if (origins.size >= 2) return 'corroborated';
  return origins.size === 1 ? 'source_backed' : 'none';
}

/**
 * Whether a source backs the claim in a way that can be counted.
 *
 * `derived` came out of another of these, so it is not independent of it by
 * construction. `contradicting` argues the other way, and recording it is worth
 * doing (ADR 0022) — counting it as support is not.
 */
function corroborates(source: FrontmatterSource): boolean {
  if (source.role === 'derived' || source.role === 'contradicting') return false;
  return source.uri !== undefined || source.content_hash !== undefined;
}

/**
 * What a source ultimately came from, as far as the record can say.
 *
 * The host for a web locator, because two pages on one site are one publisher
 * agreeing with itself. Anything else is its own locator, or — for a source with
 * only a fingerprint — the fingerprint, which is as much identity as there is.
 *
 * `URL` lowercases the host for us, so `EXAMPLE.com` and `example.com` are one
 * origin without this doing anything about it.
 */
function originOf(source: FrontmatterSource): string {
  const uri = source.uri;
  if (uri === undefined) return `hash:${source.content_hash ?? ''}`;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `host:${parsed.host}`;
    }
  } catch {
    // Not a URL at all: a repository path, a commit, an identifier somebody
    // else's system uses. Its own text is the best identity it has.
  }
  return `uri:${uri}`;
}

/** One frontmatter field that differs between two revisions. */
export interface MetadataChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * The frontmatter fields that differ, in the order the file writes them.
 *
 * `updated_at` is skipped: it differs by construction on every revision, and a
 * list of changes whose first entry is always the same one is a list people
 * stop reading.
 */
export function compareFrontmatter(from: Frontmatter, to: Frontmatter): MetadataChange[] {
  const changes: MetadataChange[] = [];
  for (const field of FRONTMATTER_KEY_ORDER) {
    if (field === 'updated_at') continue;
    const before = (from as Record<string, unknown>)[field];
    const after = (to as Record<string, unknown>)[field];
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
      changes.push({ field, from: before ?? null, to: after ?? null });
    }
  }
  return changes;
}

/**
 * The tags an item carries, as they are written down.
 *
 * Canonical form for each, then one of each spelling, then sorted. Two tags
 * that differ only in case or in how they are composed are one tag, and the
 * first spelling given is the one kept — the workspace shows what somebody
 * wrote rather than a lower-cased version of it.
 */
export function tagList(tags: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const shown = canonicalTag(raw);
    if (shown === '') continue;
    const key = normaliseTag(shown);
    if (!seen.has(key)) seen.set(key, shown);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Where an item with no category lives, so every item still has a path. */
