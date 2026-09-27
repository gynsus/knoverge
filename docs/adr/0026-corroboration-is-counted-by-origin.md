# ADR 0026: Corroboration is counted by origin, not by locator

- Status: Accepted
- Date: 2026-09-27

## Context

`EvidenceState` has three values and the product can reach two of them.

`KNOWLEDGE_MODEL.md` section 8 defines the third: `corroborated` when "two or
more independent sources or agents support the claim". `IMPLEMENTATION_PLAN.md`
lists "evidence state derivation (`source_backed`, `corroborated`)" among
milestone 7's deliverables. The briefing's trust score gives a corroborated item
two points where a source-backed one gets one.

Nothing sets it. `evidenceFrom` says why:

> `corroborated` is two or more independent sources and is decided by review
> rather than by counting, so nothing here ever sets it.

That comment is half right, and the half it is right about is the important
half: counting locators does not establish independence. Two links to the same
article, a page and its mirror, a document and a quote from it — each is two
entries in the list and one source in the world. A count would announce
independent corroboration where there is none, and an item that overstates what
backs it is worse than one that says nothing.

The half it is wrong about is the conclusion. A value decided by review is a
value somebody sets once and nobody maintains: edit the sources afterwards and
the claim about them stays where it was. Every other derived property in this
codebase — `evidence` itself, `disputed` (ADR 0022), `stale` (ADR 0024) — is
computed for exactly that reason.

## Decision

**`corroborated` is derived, from origins rather than from entries.**

A source corroborates a claim when all three hold:

- it would make the item `source_backed` on its own — a locator or a content
  hash, because a source nobody else can check is not evidence;
- its role is `primary` or `supporting`. `derived` means it came out of another
  of these, so it cannot be independent of it by construction, and
  `contradicting` argues the other way;
- its **origin** differs from every other counted source's.

An origin is what the source ultimately came from, as far as the record can say:

| Source | Origin |
| --- | --- |
| an `http`/`https` locator | the host, lowercased |
| any other locator | the locator itself |
| no locator, a content hash | the hash |

Two or more sources with distinct origins, and the item is `corroborated`. One,
and it is `source_backed`. None, and it is `none`.

**Why the host and not the URL.** Two pages on one site are one publisher
agreeing with itself, and that is the mistake a locator count makes most often —
an agent citing three paragraphs of the same document. Counting hosts refuses
that case, which is the common one, and accepts a page and its mirror on another
domain, which is the rare one. It is a claim about the record, not about the
world, and section 8 now says so in as many words.

**Why not leave it to review.** A reviewer's judgement about the sources is
recorded already, in `review`: ADR 0009 split these into orthogonal properties so
that "a human checked this" and "this rests on more than one thing" are two
answers rather than one blurred one. Putting a second human judgement into
`evidence` would make the two axes the same axis again, and it would go stale the
moment the sources changed.

## Consequences

- Nothing new is stored and no migration is needed. `evidence` is computed at
  every write, exactly as it was, from one more thing about the same list.
- The knowledge list stops collapsing evidence to "has sources" and names which
  of the three it is. A state nothing distinguishes is a state nobody sees.
- `evidence_states` on the list and the search already filter on it, so the pile
  of corroborated items is reachable the day this lands.
- An item can lose `corroborated` by an edit that removes a source or changes a
  role, which is right: the claim about its evidence follows its evidence.
- Two mirrors of one page on two hosts are counted as two. The rule is written
  down so that a reader knows what the badge asserts, and it asserts what the
  record can establish rather than what is true of the world.

## Alternatives considered

**Count the sources.** The obvious reading of "two or more". Rejected for the
reason the original comment gave: an agent citing three sections of one document
would be announced as having independent corroboration, and that is the most
likely way for the value to be set at all.

**Leave it unreachable and remove it from the model.** Honest, smaller, and the
codebase's own instinct — a field carried everywhere and set nowhere is worse
than a missing one. Rejected because the plan and the knowledge model both ask
for it, and because the thing it distinguishes is worth knowing while reviewing:
one source and two are a different bet.

**Let a reviewer set it while approving.** Rejected above: it duplicates `review`
and it goes stale.

**Require the two sources to be different `type`s as well.** Stricter, and wrong
in the case that matters most: two independent write-ups of the same decision are
both `web_url`, and refusing to call that corroboration would leave the value
nearly as unreachable as it was.
