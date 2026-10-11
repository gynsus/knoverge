# 42. The gardener files, it does not ask

Date: 2026-10-11

Status: accepted

## Context

ADR 0039 split gardening by what a finding rests on, and said what every
finding is:

> Every gardening finding is a proposal, and nothing else. [...] The gardener
> gets no `allow_direct` path, and no policy rule can give it one — not because
> the policy could not express it, but because there is no actor on the other
> end to hold responsible for the result.

That settled the intent and left the mechanism open, and the mechanism turns out
to contradict the intent. Every write in this product runs through the proposal
machinery, which asks the policy what the actor may do and applies the write
itself when the answer is `allow_direct`. The gardener runs on a schedule with
nobody signed in, so it has to act as some actor, and the only actor an
installation owns is the workspace's system actor — one per workspace, created
with the workspace, already used by bootstrap, by import and by the command
line.

The system actor is the host operator. `AuthorizationService` says so in three
places and means it: `check` returns `system_actor` without reading a grant,
`missingAction` returns nothing missing, and `defaultEffect` returns
`allow_direct`. That is correct for what it was written for — somebody at the
command line owns the database and the secrets, and pretending to constrain them
would only break the documented recovery path.

So a gardener that proposes the way an agent proposes would be told it may write
directly, and would tidy the knowledge base without asking anybody. The rule
that forbids this is in an ADR; nothing in the code would stop it.

## Decision

**The gardener does not ask the policy, because the answer would be the wrong
one.** It files a proposal for review, and the decision it records is fixed at
`require_review` rather than read from `policyDecisionFor`.

This is a separate entry point on `ProposalService`, not a flag on the existing
one. The two differ in what they are allowed to conclude, and a parameter that
turns a write into a filing is a parameter somebody passes wrongly once. There
is no argument the gardening path can be called with that produces a write: the
`apply` closure the proposal machinery holds is only ever run by an approval.

**The gardener acts as the workspace's system actor, with `client` set to
`gardener`.** No new actor type: `system` already exists in the contract, the
table already holds exactly one per workspace by partial unique index, and the
meaning is right — this is the installation acting, not a person and not an
agent somebody connected. What distinguishes a gardening proposal from an
operator's command-line write is the client on the provenance and the rule named
on the proposal, which is what a reviewer needs to disagree with the rule rather
than with the finding.

**Gardening is a per-workspace setting, off until somebody turns it on.** A
workspace is the unit of knowledge and of review, so it is the unit of tidying:
one may want it and the next may not, and the queue a flood would ruin belongs
to a workspace rather than to the installation. Off by default because the first
thing gardening does is make work for people, and an installation that has just
imported a vault should not find fifty proposals waiting before anybody asked
for any.

**A run is recorded, with what each rule did.** The findings are proposals and
live in the review queue; what the run itself did — which rules ran, how much
each read, how many findings each filed, and which rules were held back by the
cap or skipped for want of a provider — is a row of its own. Without it the
screen could only say that gardening is on, and a rule that found nothing would
be indistinguishable from a rule that never ran.

**The caps are the workspace's, and a rule that hits one reports the count
rather than filing the rest.** Two numbers: findings per run and findings per
rule. The per-rule cap is what stops one noisy rule from being the whole run.

## Consequences

The rule in ADR 0039 is now a property of the code rather than a decision
somebody has to remember. A gardening rule cannot write, whatever the workspace
has configured and whatever a policy rule says, because the path it runs on has
no branch that writes.

The system actor keeps its meaning and its privileges, and gains a second
caller that deliberately declines them. `defaultEffect` returning `allow_direct`
for a system actor stays correct, because the gardener never reaches it.

A reviewer reading the queue sees the installation as the proposer of some
items. That is the honest answer to who found them, and the alternative — a
synthetic "gardener" agent — would put a row in the agent list that nobody can
connect with, revoke, or give a credential to, and would show up in the policy
screens as something an operator could grant permissions to. An agent nobody
can authenticate as is not an agent.

ADR 0039 predicted one additive migration, for an index on `content_hash`:

> `content_hash` is on a revision and is not indexed: nothing has needed to ask
> which _other_ item carries the same hash.

That turns out not to be the query. Asking which pairs of items in a workspace
share a hash reads every active item's current revision, reaching each by
primary key, and groups them; an index on `content_hash` cannot make a group-by
over the whole set cheaper. The additive migration this milestone carries is the
settings and the run record instead, and the index is not added, because an
index nothing uses is a write cost on every revision for a query nobody runs.

## Rejected alternatives

### A `gardener` actor type beside `human`, `agent` and `system`

The reading that the question invites, and it would make the authorisation
difference explicit rather than conventional: a `gardener` actor would simply
have no default `allow_direct`. Rejected because the type would exist to carry
one fact about one caller, and the model would then have four actor types where
one of them names a job rather than a kind of participant. The next scheduled
reader would face the same question again, and the answer "its path does not
write" scales where "give it a type" does not.

### A flag on the existing propose methods

Smaller, and the diff would be a few lines instead of a method. Rejected because
the flag's default decides what happens when somebody forgets it, and the
forgetful case would be a scheduled job writing to the knowledge base
unreviewed. A separate entry point has no default to get wrong.

### Let the policy answer, and write a rule that denies the gardener

Faithful to the way everything else works: the policy decides, and an operator
could read the rule that constrains gardening. Rejected because the operator
could also change it, and ADR 0039 settled that no policy rule can give the
gardener a direct path. A constraint an operator can lift is not the constraint
that ADR describes — and the operator lifting it would be granting direct writes
to an actor that also happens to be the recovery identity.
