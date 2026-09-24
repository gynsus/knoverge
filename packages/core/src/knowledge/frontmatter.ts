import type { EvidenceState, Frontmatter, FrontmatterSource } from '@knoverge/contracts';
import { FRONTMATTER_KEY_ORDER, canonicalTag, normaliseTag } from '@knoverge/contracts';

/**
 * `source_backed` needs a source somebody else could check: a locator, or a
 * fingerprint of the bytes (KNOWLEDGE_MODEL.md section 8). A source with
 * neither is an assertion about where something came from, not evidence of it.
 *
 * `corroborated` is two or more independent sources and is decided by review
 * rather than by counting, so nothing here ever sets it.
 */
export function evidenceFrom(sources: readonly FrontmatterSource[]): EvidenceState {
  return sources.some((s) => s.uri !== undefined || s.content_hash !== undefined)
    ? 'source_backed'
    : 'none';
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
