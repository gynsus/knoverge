# ADR 0023: The semantic thresholds are measured, and they diverge

- Status: Accepted
- Date: 2026-09-26

## Context

Two places compare passages by embedding similarity, and both numbers were
guesses.

`SEMANTIC_SIMILARITY_THRESHOLD = 0.88` decides whether the duplicate screen
offers a candidate, which refuses a write until the proposer either changes the
item it names or says they have ruled it out. Its comment said so plainly:

> It is a starting point rather than a measured value: tuning it needs a corpus,
> an embedding model and somebody's judgement about pairs, and until all three
> exist the conservative number is the honest one.

`SEMANTIC_MATCH_THRESHOLD = 0.8` decides step E of reconciliation, which offers
an agent a candidate to read.

All three things the comment asked for now exist: a workspace holding eighty
items, `bge-m3` reachable through Ollama, and somebody willing to label pairs.

## The measurement

Method, replicating what the running system does rather than approximating it:
`bge-m3` (1024 dimensions) through Ollama, the probe text embedded as
`title\n\nbody` exactly as `DuplicateMatcher` passes it to `nearest`, compared
against the chunk embeddings already in the workspace database with
`1 - (vector <=> probe)`, taking the best chunk per item — which is the
`nearest` port, run by hand.

Thirty-eight labelled measurements over the eighty items of the project's own
workspace, in four classes:

| Class | n | min | median | max |
| --- | --- | --- | --- | --- |
| **duplicate** — the same assertion, written twice by the same author | 3 | 0.8302 | 0.8827 | 0.9070 |
| **paraphrase** — the same assertion, rewritten in another voice | 14 | 0.6585 | 0.7829 | 0.8313 |
| **related** — a different assertion about the same thing | 11 | 0.4891 | 0.6652 | 0.8454 |
| **unrelated** — different subjects, plus two off-topic probes | 10 | 0.3522 | 0.4395 | 0.5306 |

Three findings, in order of how much they matter.

**0.88 is effectively off.** It admits one of the seventeen pairs that are the
same assertion. The check that exists to stop an agent recording what the
workspace already holds has, on this corpus, never once fired for that reason.
The conservative number was not conservative; it was inert.

**No threshold separates "the same assertion" from "closely related".** The
lowest true positive is 0.6585 and the highest related pair is 0.8454, so the
two classes overlap across the whole usable range. The worst offender is honest
about why: "Agents receive read, search and propose by default" and "Agents do
not silently overwrite canonical knowledge" score 0.8454 because they are two
halves of one rule. This corpus is adversarial in a way a real one often is —
eighty short items in one voice about one piece of software — and whole-passage
embedding similarity is not a duplicate detector on it.

**"Nothing to do with it" separates cleanly.** Nothing unrelated reaches 0.5306
and nothing that is the same assertion falls below 0.6585, leaving 0.126 of
empty space between them.

## Decision

**The two thresholds diverge much further than they did, because they decide
different things, and each is set where the measurement supports it.**

**Reconciliation step E: 0.8 → 0.60.** This offers a candidate to read, and an
agent that looks and disagrees has lost a glance. 0.60 sits in the empty band:
0.07 above every unrelated measurement and 0.058 below every true positive. It
admits all seventeen same-assertion pairs where 0.8 admitted four, and it admits
eight of the eleven related pairs — which is the wanted behaviour, not a false
positive. During reconciliation a different assertion about the same thing is
exactly what an agent should be shown before it writes a third one.

**The duplicate screen: 0.88 → 0.75.** This refuses a write, so it is set for
precision rather than recall. On this corpus 0.75 admits twelve of the seventeen
same-assertion pairs and one of the twenty-one others — thirteen candidates, one
of them arguable and none of them absurd. It is the knee: every step lower buys
one more true positive at a falling price, and the two steps above it throw away
nine true positives to remove nothing.

**Neither number is presented as a property of the product.** They are what one
model measured on one corpus. The duplicate screen already takes
`semanticThreshold` as an option for exactly this reason; step E's is a module
constant and stays one until somebody has a second corpus to disagree with.

## Consequences

- An agent proposing knowledge the workspace already holds in other words is now
  usually asked to look first, where before it almost never was. The refusal is
  recoverable: read the candidate, change it or acknowledge it, which is what
  `acknowledged_duplicate_ids` on the proposal is for.
- Roughly one write in fourteen will be asked about an item that was related and
  not the same. That is the price of the recall, it is paid in one round trip,
  and the acknowledgement is recorded on the proposal so a reviewer sees what the
  proposer considered and dismissed.
- Reconciliation will classify more incoming candidates as
  `semantic_match_suspected` than as `new`. That is the protocol working: rule 5
  exists so that a newly connected agent does not blindly duplicate, and a
  reconciliation pass that answers "new" to a rewritten copy has failed at the
  one job it has.
- A future embedding model shifts these numbers and the decision has to be
  re-made, not inherited. The method above is the part worth keeping.
- The duplicate screen is not, and should not be read as, the mechanism that
  catches a rewritten duplicate. It catches the blatant ones and asks about the
  strong ones. The mechanism for a rewrite is reconciliation, whose whole purpose
  is to ask before writing, and whose threshold is set to catch all of them.

## Alternatives considered

**Leave 0.88 and record that it is untuned.** Rejected: the comment already said
it was untuned, and a check nobody has measured is indistinguishable from a check
that does not run. Having measured it, leaving it would be a decision to keep a
feature that protects nothing.

**One threshold for both, somewhere in the middle.** Simpler to explain and
wrong in both directions at once: high enough to be safe for a refusal is too
high to be useful for a suggestion, and low enough to be useful for a suggestion
turns a recoverable refusal into a toll on ordinary writes.

**Set the duplicate screen at 0.60 as well, for the recall.** Rejected on the
numbers: it admits eight of the eleven related pairs, so roughly a third of the
candidates it raised would be items that were never the same. A refusal that is
wrong a third of the time teaches a proposer to acknowledge everything without
reading, and then the check protects nothing while costing everybody a round
trip — which is the failure mode the original comment was written to avoid. The
recall is bought at step E instead, where being wrong is free.

**Ask an LLM to judge each candidate pair instead of thresholding.** The obvious
way past a weak signal, and it may well be right later. Rejected now because rule
9 says the core works with no provider configured, so this could only ever be an
improvement on top of a threshold that has to work on its own — and that
threshold is what this ADR is about. It also turns a refusal an agent can
understand into one nobody can predict.
