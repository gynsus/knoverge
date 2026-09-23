# ADR 0017: A duplicate you cannot see

- Status: Accepted
- Date: 2026-09-23

## Context

`DuplicateMatcher` stops a proposer recording what the workspace already holds. It answers with the candidates it found: their ids, their titles and their file paths, so the proposer can read them and either change one or say which it has ruled out.

It never asked whether the proposer may read them.

An agent scoped to one branch could therefore propose a title and learn, from the refusal, that an item exists in a branch it has no permission to read — its title, and the path it lives at. Trigram similarity fires at 0.6, so guessing is cheap: a proposer could map a closed branch by proposing titles and reading the answers.

`AGENT_ONBOARDING_AND_RECONCILIATION.md` section 19 forbids exactly this for the reconciliation protocol, and the sync tools honour it. The write path is older than that requirement and does not.

The obvious fix — tell the proposer nothing about a match it cannot see — has a hole. Continuing past `DUPLICATE_SUSPECTED` means naming the candidate you ruled out, and an id nobody may see is an id nobody can name. A refusal the proposer can never satisfy is worse than the leak: it stops them recording anything at all, for a reason they cannot be told.

## Decision

**A match the proposer cannot read is not raised, and sends the write to review.**

The matcher splits what it finds by the proposer's own read scope, asked of the same authorisation service the rest of the interface asks. Matches the proposer may read behave exactly as before: `DUPLICATE_SUSPECTED` names them, and acknowledging one is how the proposer proceeds. Matches it may not read are returned to the caller instead of raised.

When there are any, the write loses its direct route: a policy decision of `allow_direct` becomes `require_review` for that write alone. Somebody who can see both the proposal and the item decides, which is what review is for.

The same applies to `DUPLICATE_EXTERNAL_KEY`. It is normally final — two records under one external identity are one record — but a key held by an item the proposer cannot read is a refusal it cannot act on, because it can neither read that item nor update it. Review decides.

## Consequences

- A proposer learns nothing about knowledge it may not read. What it observes is that its write was queued rather than applied, which policy does for its own reasons and carries no information about what is in the workspace.
- A proposer is never stuck. Everything it can see, it can rule out; everything it cannot see, it does not have to.
- A reviewer sees the proposal with their own scope, and the check that runs again on approval raises the strong matches — same text, same external key — against what *they* can read. A close title is not re-raised, as it has never been: that is a question for the proposer, and the reviewer is reading the text.
- An `allow_direct` rule is no longer a guarantee that a write is applied immediately. It was never one — policy could already have been narrowed by a deny grant — but this adds a reason the proposer cannot predict.
- Nothing is stored on the proposal. The hidden match is the reason the write went to review, not a finding the workspace keeps: the reviewer's own check finds what matters to them, and recording an id the proposer may not see on a row the proposer may read would put back the leak this removes.

## Alternatives considered

**Tell the proposer one bit** — "something you cannot see may match" — and let it acknowledge blindly. Honest to the proposer, and it keeps them unstuck. Rejected because the bit is exactly what makes probing work: a proposer could still map a closed branch by watching which titles produce it, which is the attack this is about.

**Hide the match entirely and let the write through.** No leak at all, and the workspace ends up with two items for one fact, which is the thing the matcher exists to prevent.
