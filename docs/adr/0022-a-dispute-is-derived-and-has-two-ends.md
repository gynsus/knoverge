# ADR 0022: A dispute is derived, and it has two ends

- Status: Accepted
- Date: 2026-09-26

## Context

`disputed` has been in the knowledge model since milestone 1. It is a column in
`knowledge_items`, a field in the frontmatter, a value in every item the API
returns, a badge in the knowledge list, and a five-point penalty in the briefing
trust score.

Nothing anywhere can set it to `true`.

The `contradicts` relation is in `RelationType`, agents can record it, and no
code reads it. So the badge cannot appear, the penalty cannot apply, and an
agent that faithfully reports "this disagrees with what you already hold" is
answered with silence. A field that is carried everywhere and set nowhere is
worse than a missing one: it looks like an answer.

`KNOWLEDGE_LIFECYCLE.md` section 6 already settles the semantics:

> Both items keep their lifecycle status and their review and evidence state.
> Their `disputed` flag becomes true until a human resolves the contradiction by
> supersession, rejection, or explicit acceptance of both with temporal
> validity, after which the flag clears.

What it does not settle is the mechanics, and there are three real questions.

**Who holds the flag.** The relation is one-directional: `A contradicts B` is a
row on A. B is equally in doubt and its file says nothing.

**What clears it.** The document names three resolutions. Two of them are
somebody else's operation — a supersession, a rejected proposal. Only the third,
"explicit acceptance of both with temporal validity", sounds like an act aimed
at the dispute itself, and there is no operation for it.

**Whether a human can dispute an item directly.** `KNOWLEDGE_MODEL.md`
section 8 says `disputed` is true "while an unresolved `contradicts` relation
**or explicit human doubt** exists". A settable flag beside a derived one is two
sources for one fact, which is what ADR 0015 refused.

## Decision

**`disputed` is derived, never set. It is a verdict on the item's contradiction
relations, in both directions, at the present instant.**

An item is disputed when a live `contradicts` relation connects it to another
item — in either direction — and that other item is `active` and its validity
window overlaps this item's window.

Nothing writes the flag directly. There is no dispute operation and no resolve
operation, because all three resolutions the lifecycle document names fall out
of the rule:

- **supersession** leaves the other side `superseded`, so it is not active, so
  the dispute is not live;
- **rejection** means the relation was never recorded;
- **accepting both with temporal validity** means setting `valid_from` and
  `valid_until` so the two claims were never true at the same instant — which
  is what "they do not actually contradict" means, stated in the data rather
  than in a flag.

Removing the relation also clears it, which is the fourth resolution: the
contradiction was reported in error.

**A dispute is written to both files, in different forms.** Following ADR 0015:
the relation is recorded once, on the item that reports it, and the other item's
frontmatter gains `disputed_by` — the ids of the items whose `contradicts`
relation currently disputes it. It is a projection of those relation rows, never
a relation row itself, and `RelationType` still has no `disputed_by`.

So a file read on its own says whether it is disputed and by what: outgoing
contradictions are in `relations`, incoming ones in `disputed_by`, and
`disputed` is true exactly when one of the two lists has something effective in
it.

**Recomputing a dispute is a revision.** An item's frontmatter changed, so rule
1 applies: it is a new revision and a Git commit. Reporting `A contradicts B`
produces one commit with two revisions, exactly as a supersession does, and the
commit carries a `Knoverge-Change` trailer for each.

**The fan-out is one level deep.** Dispute state is not an input to anybody
else's dispute state — only status and validity windows are, and recomputing a
verdict changes neither. So a write recomputes the verdict for the item itself
and for its contradiction partners, and stops. There is no cascade to bound.

**Explicit human doubt is recorded as an item.** A human who doubts something
writes down what they doubt and relates it with `contradicts`. That is better
provenance than a boolean — it says what the objection is, who made it and when,
and rule 15 already asks for one assertion per item. `KNOWLEDGE_MODEL.md`
section 8 is amended to say so.

## Consequences

- `Frontmatter` gains one optional field, `disputed_by`, and
  `FRONTMATTER_KEY_ORDER` one entry. Files written before this are unchanged:
  absent means nobody disputes it.
- Five operations grow a recompute step, because five of them can change a
  verdict: `create` and `update` (the relations and the window),
  `supersede`, `delete` and `restore` (the status). Each writes the partner
  files it flips into its own commit.
- A write whose text changes nothing can still produce a commit, when what it
  changed was somebody else's verdict. `update` no longer treats an empty
  commit as the only possible no-op.
- The `disputed` column in PostgreSQL stays, as a materialised projection
  maintained by the same writes, in the same sense the `evidence` column is.
  Search and the briefing read it and need no join to do it.
- An agent reporting a contradiction cannot do it silently: `contradicts` is in
  the relations list of a proposal, so by rule 14 it reaches a human unless a
  policy rule says otherwise, and the human sees both items marked.
- Two items that disagree about different periods are not disputed, which means
  `valid_from` and `valid_until` stop being decoration. Agents that record
  temporal validity get a quieter ledger than agents that do not.

## Alternatives considered

**A settable flag with `knowledge_dispute` and `knowledge_resolve_dispute`
operations.** The smallest change, and it gives a reason field a derived flag
has nowhere to put. Rejected: the flag then has two sources — the operation and
the relation — and ADR 0015 already answered what happens next. It also lets a
dispute be resolved by clearing the flag while the contradiction it was about is
still recorded and still true, which is a lie that survives review.

**Derive the flag but keep it out of frontmatter.** Removes the second file
write and the whole fan-out. Rejected because it breaks rule 1 in the way that
matters most: a reader with the repository and no application would see
`disputed: false` on an item the system considers disputed. Dropping the field
from the file instead would mean the file cannot say it at all.

**Make `contradicts` symmetric — require or create a relation row on both
items.** The obvious way to give both ends the flag. Rejected for ADR 0015's
reason: two rows for one fact, and no answer when they disagree. It also loses
who reported the contradiction, which is the one thing a contradiction most
needs to record.

**Let the verdict ignore validity windows.** Simpler, and closer to what a first
reading of "an unresolved `contradicts` relation" suggests. Rejected because it
leaves the lifecycle document's third resolution unimplementable, so the only
way out of a dispute between two claims that were both true, at different times,
would be to delete one of them.
