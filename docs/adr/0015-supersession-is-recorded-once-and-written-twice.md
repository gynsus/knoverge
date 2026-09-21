# ADR 0015: Supersession is recorded once and written twice

- Status: Accepted
- Date: 2026-09-21

## Context

`KNOWLEDGE_LIFECYCLE.md` section 5 says a supersession records the relation "in both frontmatters".

`packages/contracts` says the opposite, deliberately. `RelationType` omits `superseded_by` and explains why: "it is `supersedes` read from the other end, and storing both directions gives two rows that can disagree." The `Frontmatter` schema is `.strict()` and has no field for it either, so the old item's file has nowhere to say what replaced it.

Both documents are defending something real. The contract is defending a single source of truth: two relation rows describing one fact will eventually disagree, and then nothing can say which is right. The lifecycle document is defending rule 1 — the repository must be readable **and navigable** without the application. An old file that says `status: superseded` and nothing else is a dead end: a person reading it knows the item was replaced and has no way to find what replaced it short of grepping every other file for a relation naming it.

This surfaced while implementing `knowledge_propose_supersede`, which cannot be written until the question is answered.

## Decision

**The relation is recorded once and written twice, in different forms.**

PostgreSQL holds exactly one relation row: `new supersedes old`. Nothing stores the reverse direction as a relation, and `RelationType` keeps `superseded_by` out, unchanged.

The new item's frontmatter carries that relation in its `relations` list, as every other relation is carried.

The old item's frontmatter gains a derived field, `superseded_by: <new item id>`, alongside the `status: superseded` and `valid_until` it already sets. It is a projection of the one relation, in the same sense that rule 1 already calls frontmatter relations "a portable projection". It is written by the supersession that creates the relation and by nothing else.

## Consequences

- Reading the old file alone answers both questions a reader has: that it was replaced, and by what. Rule 1's "navigable" holds in both directions.
- There is still one place a supersession can be changed, so there is still nothing to disagree with. A tool that rewrites `superseded_by` by hand is editing the repository directly, which `GIT_REPOSITORY.md` section 9 already declares unsupported.
- `Frontmatter` gains one optional field and `FRONTMATTER_KEY_ORDER` one entry. Files written before this exist unchanged: the field is optional and absent means not superseded.
- `KNOWLEDGE_LIFECYCLE.md` section 5 says which form goes in which file, instead of "both frontmatters", which read as though the same relation entry appeared twice.

## Alternatives considered

**Leave the old file with only `status: superseded`.** The smallest change, and the one that keeps the contract exactly as written. Rejected because it makes the repository a dead end in the direction people actually read it: an old fact is what somebody finds first, and "this was replaced, good luck" is not navigable. Recovering the pointer means scanning every file in the repository.

**Add `superseded_by` to `RelationType` and store both rows.** This is what "mirrored in both frontmatters" reads like on first pass. Rejected for the reason the contract already gives: two rows for one fact, two places to update, and no answer when they differ.

**Put the pointer in the old item's `relations` as `supersedes` aimed at the new item.** Rejected because it inverts the meaning of the relation. A reader — human or agent — would conclude the old item replaced the new one.
