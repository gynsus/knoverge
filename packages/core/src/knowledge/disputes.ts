import type {
  Frontmatter,
  FrontmatterRelation,
  ItemStatus,
  KnowledgeItemId,
} from '@knoverge/contracts';

/**
 * Whether a contradiction between two items is live, and who is in it.
 *
 * `disputed` is derived and nothing sets it (ADR 0022): an item is disputed
 * when a `contradicts` relation connects it to another item, in either
 * direction, and that other item is still active and was true at the same time
 * as this one. So a dispute ends when one side is superseded or deleted, when
 * the relation is withdrawn, or when somebody accepts both claims and says with
 * `valid_from` and `valid_until` which period each one belongs to.
 */

/** The period a claim says it is true for. Open at either end. */
export interface ValidityWindow {
  from: string | null;
  until: string | null;
}

/**
 * One side of a possible contradiction, as the verdict needs to see it.
 *
 * Deliberately not the item record: the verdict is computed for an item as it
 * is *about to be*, from a frontmatter that has not been written yet.
 */
export interface DisputeSide {
  itemId: KnowledgeItemId;
  status: ItemStatus;
  window: ValidityWindow;
}

/**
 * Whether two claims were ever true at the same instant.
 *
 * Half-open intervals: `from` is inclusive, `until` is the instant the claim
 * stopped holding, which is also the instant its replacement starts — that is
 * how supersession sets the pair, so treating `until` as exclusive is what
 * keeps a supersession from reading as a contradiction with itself.
 *
 * A null end is unbounded, which is the common case: an item that says nothing
 * about when it was true is taken to be claiming it always was.
 */
export function windowsOverlap(a: ValidityWindow, b: ValidityWindow): boolean {
  return startsBefore(a.from, b.until) && startsBefore(b.from, a.until);
}

function startsBefore(from: string | null, until: string | null): boolean {
  if (from === null || until === null) return true;
  return Date.parse(from) < Date.parse(until);
}

/**
 * Whether `other` is a live dispute against `self`.
 *
 * The direction of the relation does not enter into it. Who reported the
 * contradiction matters for provenance, not for whether it is still open.
 */
export function disputes(self: DisputeSide, other: DisputeSide): boolean {
  if (other.itemId === self.itemId) return false;
  if (self.status !== 'active' || other.status !== 'active') return false;
  return windowsOverlap(self.window, other.window);
}

/** The `contradicts` targets a frontmatter relations list names, deduplicated. */
export function contradictionTargets(relations: readonly FrontmatterRelation[]): KnowledgeItemId[] {
  return [
    ...new Set(
      relations.filter((r) => r.type === 'contradicts').map((r) => r.target as KnowledgeItemId),
    ),
  ];
}

/**
 * The verdict for one item: whether it is disputed, and by which items.
 *
 * `disputedBy` carries only the *incoming* side, because the outgoing side is
 * already in the item's own `relations` list and ADR 0022 keeps one fact in one
 * place. Both sides decide the flag; only one of them is projected.
 *
 * Sorted, so that two runs over the same state render the same bytes.
 */
export interface Verdict {
  disputed: boolean;
  /** Only the incoming side, sorted. */
  disputedBy: KnowledgeItemId[];
}

export function verdict(
  self: DisputeSide,
  /** Items this one says it contradicts. */
  outgoing: readonly DisputeSide[],
  /** Items that say they contradict this one. */
  incoming: readonly DisputeSide[],
): Verdict {
  const disputedBy = [
    ...new Set(incoming.filter((other) => disputes(self, other)).map((other) => other.itemId)),
  ].sort();
  const disputed = disputedBy.length > 0 || outgoing.some((other) => disputes(self, other));
  return { disputed, disputedBy };
}

/**
 * A frontmatter with a verdict applied.
 *
 * `disputed_by` is dropped rather than written empty, because that is the shape
 * the same frontmatter has after a round trip through a file: the renderer
 * leaves an empty list out, so a stored copy that keeps one would differ from
 * the canonical copy it describes and show up as a change in a diff that
 * changed nothing.
 */
export function applyVerdict(frontmatter: Frontmatter, applied: Verdict, now: Date): Frontmatter {
  const next = {
    ...frontmatter,
    disputed: applied.disputed,
    disputed_by: [...applied.disputedBy],
    updated_at: now.toISOString(),
  } as Frontmatter;
  if (next.disputed_by?.length === 0) delete next.disputed_by;
  return next;
}

/** Whether a frontmatter already says what the verdict says. */
export function sameVerdict(frontmatter: Frontmatter, applied: Verdict): boolean {
  const was = frontmatter.disputed_by ?? [];
  return (
    frontmatter.disputed === applied.disputed &&
    was.length === applied.disputedBy.length &&
    was.every((id, index) => id === applied.disputedBy[index])
  );
}
