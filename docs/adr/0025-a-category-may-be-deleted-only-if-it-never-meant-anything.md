# ADR 0025: A category may be deleted only if it never meant anything

- Status: Accepted
- Date: 2026-09-26

## Context

The taxonomy screen offers **merge** and **archive** and no delete, and two code
comments explain why:

> Archive rather than delete: a category holds knowledge, and nothing here should
> be able to take it with it.

> Agents propose categories, so a workspace accumulates near-duplicates, and
> deleting one would take the knowledge filed under it. A merge moves everything
> to the survivor instead.

Both are right, and the reasoning goes further than the comments say. A
category's path is in the frontmatter of every item beneath it and in the layout
of the repository. Its id is a security identifier (rule 13) that grants and
policy rules store in a JSON scope **with no foreign key**, so a deleted row
would leave a grant pointing at nothing and nothing in the database would object.
`CategoryStatus` has no `deleted` for exactly these reasons.

What none of that addresses is a category somebody created by mistake. Archiving
it hides it and leaves it in the tree and in `taxonomy.yaml` for ever, and
`archived` is the wrong word: it says "we used to use this", not "this should
never have existed". A curator who mistypes a name has no way to undo it.

## Decision

**A category may be deleted, and only when nothing has ever depended on it.**

`taxonomy.delete` refuses unless every one of these holds, and says which one
failed:

- it has no descendants, at any status;
- no knowledge item is filed under it;
- it has no aliases;
- no proposal targets it;
- no permission grant and no policy rule names it in a scope;
- its status is not `merged`.

Each condition is a thing that would otherwise be silently broken. Descendants
would be orphaned; an item would lose the category its file is named after — the
foreign key is `restrict` and would refuse anyway, so the check exists to say so
in words; an alias is a path an agent may have recorded; the proposals foreign
key is `cascade`, so deleting a category would delete pending proposals targeting
it, which is the one case where the database would not object and the loss would
be real; a grant or rule would be left scoped to an id that no longer exists; and
a `merged` category's path is an alias of its survivor, so removing it stops that
path resolving.

The result is a real deletion. There is no `deleted` status, the row is gone, the
category leaves `taxonomy.yaml`, and the taxonomy version moves as it does for
any other change. The ledger keeps a `category.deleted` event, so what happened
is on record even though the row is not: rule 4 does not require the object to
survive, only the event.

**Merge and archive remain what removal means for a category that was used.** The
screen now says so, which is the other half of the problem: the reasoning was in
the code and nowhere a curator could read it.

## Consequences

- `CategoryStatus` is unchanged. A deleted category has no status, because it has
  no row.
- `EventType` gains `category.deleted`, and `TaxonomyChangeKind` gains `delete`.
- Recovery gains its one special case. Every other taxonomy change leaves the
  category in the committed file, and recovery reads it from there; a delete is
  the change whose evidence is an absence. `Knoverge-Category` still names the id
  and `Knoverge-Category-Kind` still says `delete`, so the commit is
  self-describing, and recovery deletes the row when the file does not have the
  path the operation recorded.
- A curator who wants a category gone but has already filed things under it is
  told to merge it, which is the operation that exists for that and which keeps
  the old path resolving.
- Nothing about this is offered to agents. Agents propose categories; removing
  one is curation, and `taxonomy.delete` is administration like the rest of the
  taxonomy writes.

## Alternatives considered

**No delete at all, only better wording.** The smallest change, and it was the
state before this. Rejected because a typo is not a thing to live with for ever,
and because `archived` said something untrue about it. The reasoning against
deletion was always about categories that hold knowledge, and it does not reach a
category that holds nothing and never did.

**A `deleted` status, logical like an item's.** Consistent with knowledge, where
deletion is logical because the content must survive. Rejected: there is no
content to survive. A row whose whole purpose is to record that an empty category
once existed by mistake is the thing being complained about, one word further on.

**Delete and move the items to the parent.** Tempting, and it is what a file
manager would do. Rejected because it is a merge with the parent, and merge
already does it properly — moving the items, the children and the aliases, and
leaving the old path resolving. Two operations doing the same thing differently
is how they drift.

**Cascade the aliases and the proposals with it.** Fewer refusals, and the
database is already set up to cascade the proposals. Rejected for that exact
reason: a pending proposal disappearing because somebody tidied the tree is data
loss with no message, and an alias is a path somebody recorded. A refusal that
names what is in the way is a better answer than a deletion that quietly takes it.
