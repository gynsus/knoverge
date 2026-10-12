# 43. A finding that names no write is a notice

Date: 2026-10-12

Status: accepted

Amends: ADR 0039

## Context

ADR 0039 said what every gardening finding is:

> **Every gardening finding is a proposal, and nothing else.** Rule 5 says
> agents propose; a job that runs on a schedule and answers to nobody has less
> claim to write than an agent a person connected on purpose.

That is right about authority and wrong about shape, and the first two rules did
not show it. Duplicates by content hash and duplicates by text both name a
write: this item should stop being active because that one says the same thing.
A reviewer reads the pair and agrees or does not, and the proposal machinery
already holds exactly that.

Four of the rules the milestone still owes name no write at all.

A source reference no revision cites is a row that was created and never
attached to anything. An attachment whose every knowledge item has been deleted
is bytes kept for knowledge that is gone. An item whose revisions cite nothing,
in a workspace where most items cite something, is a gap in the provenance. A
category holding no items and no children is a shape nobody filled.

None of those is a write somebody could approve. The proposal types are
`knowledge_create`, `knowledge_update`, `knowledge_delete`,
`knowledge_supersede`, `category_create` and `category_update`, and not one of
them expresses "this source reference is not cited by anything". The nearest
thing — inventing a proposal type that deletes a row — would be asking a
reviewer to approve a write the gardener is forbidden to make and the product
has no screen for.

And a review queue item nobody can approve is a queue item that can never be
cleared. The queue is where somebody goes to finish a list; a permanent resident
of it makes the list a thing you stop finishing.

## Decision

**A gardening finding is a proposal when it names a write, and a notice when it
does not.** Nothing else changes about either: a proposal is filed exactly as
ADR 0042 says, through a path with no branch that writes, and a notice is
recorded and shown.

**A notice lives on the run that found it.** Not in the review queue, because
there is nothing to approve. Not in a table of its own, because a table would
exist to hold a row's lifecycle and a notice has none: it carries the rule, one
English line, and the thing it rests on.

**There is nothing to approve and nothing to dismiss.** A notice is true until
the thing it describes is fixed, and then the next run does not report it. A
dismissal would be a second kind of state about a thing the product cannot yet
change, and a dismissed notice about a condition that still holds is a lie the
operator told themselves and the product remembered.

**A rule declares which it produces.** `produces: 'proposals' | 'notices'` on
the rule, because the service has to treat them differently and inferring it
from what came back would mean a rule that found nothing had no kind.

**The run cap counts proposals, and notices are bounded by the per-rule cap
alone.** The run cap exists to keep the gardener from burying the review queue,
and a notice is not in it. A notice rule is therefore still scanned after the
run cap is reached, which is the whole point of the distinction: an operator who
has just hit the cap on duplicates still wants to know about the file nothing
rests on. The per-rule cap still applies, because the run record is a row and a
rule that noticed forty thousand things would be a row nobody can read.

## Consequences

ADR 0039's sentence is narrowed rather than reversed. The gardener still gets no
direct-write path at any trust tier, the filing path still has no branch that
writes, and every finding still names the rule and the rows it rested on. What
changes is that a finding which named no write used to have nowhere to go, and
the four rules that produce them were the four the milestone kept putting off.

A notice repeats. The same source reference will be reported by every run until
somebody removes the row, and that is the honest behaviour: it is still true.
What makes it bearable is that the screen shows runs rather than a backlog — a
reader looks at the newest run and sees what is true now, rather than at a list
that grows.

Two of the four conditions have nothing in the product that fixes them. There is
no screen that deletes a source reference and none that deletes an attachment's
bytes. So the first version of these rules tells an operator something they can
act on only through the command line or the database, which is worse than a
button and better than not knowing. If one of them turns out to be common, the
fix is an administration operation, and then the notice will have somewhere to
point.

## Rejected alternatives

### A `gardening_findings` table, with a dismissal

The shape somebody expects, and it would let a notice be closed so the screen
stops repeating it. Rejected because a dismissal only means anything if the
condition can also be fixed, and for two of the four it cannot be fixed inside
the product yet — so the button would mean "stop telling me", which is a setting
pretending to be an action. It is also a second list beside the review queue,
and the product already has one list of things waiting for a person; a second
one competes with it for the same attention and wins by being newer.

### Invent a proposal type that deletes the row

Keeps one outlet and one screen. Rejected because it would put in the review
queue a write the gardener may not make and the product cannot otherwise make,
and approving it would be the only way those rows are ever deleted — which makes
the review queue the administration screen for a table nobody else can touch.

### Say nothing, and build only the rules that produce proposals

The smallest honest answer, and it was the state of the milestone for two
rules. Rejected because the four conditions are worth knowing about — an
attachment kept for deleted knowledge is disk nobody accounted for, and an item
that cites nothing in a workspace that mostly cites something is the thing rule
3 exists to make visible. A product that computes the answer and declines to say
it is not being careful; it is being quiet.
