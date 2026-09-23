# ADR 0018: An archived workspace is read-only

- Status: Accepted
- Date: 2026-09-23

## Context

A workspace outlives the project it was made for. The client goes away, the migration finishes, the experiment is abandoned — and what the workspace holds is still worth keeping, because the reason a decision was made is worth reading years after the decision stopped mattering.

Deleting it is wrong: the knowledge, the revision history and the hash-chained ledger are the product. Leaving it live is also wrong. An agent still holds a credential for it, an import still runs against it on a schedule, and a year later somebody reviewing proposals cannot tell which of nine workspaces is the one still in use. Worse, a workspace nobody watches is a workspace where an agent writes unobserved.

There is a third failure mode, subtler: whatever "closed" means, it has to be one thing. A flag that the web interface honours and the MCP endpoint does not is not a closed workspace; it is a closed screen.

## Decision

**An archived workspace is kept, readable, and refuses every change. The state is a date, it is reversible, and it is enforced where permissions are decided.**

`workspaces.archived_at` is null while the workspace is live. Setting it changes nothing else: no rows are rewritten, no items are touched, no repository is moved. Archiving a workspace of fifty thousand items is one `UPDATE` of one row.

What makes that enough is where it is enforced. `AuthorizationService` drops a fixed set of actions while the workspace is archived, before it looks at any grant:

```text
knowledge.propose_create   knowledge.write
knowledge.propose_update   knowledge.approve
knowledge.propose_delete   taxonomy.propose
knowledge.propose_supersede taxonomy.manage
```

Every route, every tool and both transports ask that one service, so there is one answer. `check` refuses with the reason `workspace_archived`, which is what `command.denied` records — a refusal that reads as "the workspace is closed" rather than "you have no grant". `heldActions` stops reporting the frozen actions, so the interface, which builds its controls from that list, stops offering them, and the manifest's capabilities go false for the same reason. `sync_begin` is refused separately in the sync service: a reconciliation pass exists to end in proposals, and letting an agent upload an inventory to be refused at every write is a slower way of saying no.

Reading is untouched — knowledge, search, history, the event feed, the change feed. An archive nobody can read is a deletion with extra steps.

Administration is deliberately not frozen. `workspace.admin` is the way back, and freezing it would make archiving one-way. `agent.manage` is how a credential is revoked, which somebody closing a project has more reason to do, not less. `policy.manage` writes rules about how writes are applied, and there are no writes to apply.

Who may do it is `workspace.admin` in that workspace: the permission that already covers the workspace itself rather than what is in it.

Both directions are ledger events — `workspace.archived` and `workspace.restored` — and asking for the state the workspace is already in does nothing and records nothing. An event saying a workspace was archived when it already was tells a reader that nothing happened.

## Consequences

- Archiving is O(1) and reversible. A workspace archived by mistake costs a second call and loses nothing.
- Nobody can write to it: not an owner, not a trusted agent with an `allow_direct` rule, not a held credential. The permission is not there to evaluate a rule against.
- The system actor is unconstrained, as everywhere else. The operator running the command line owns the database and the ledger key; a flag in a row they can edit was never going to stop them, and pretending otherwise would break the documented recovery path.
- Every workspace-scoped write path pays one indexed primary-key lookup, and only when the action in hand is one an archive would freeze. Reads — most traffic — pay nothing. It is not cached: a stale answer would either keep refusing a workspace that was brought back, or accept a write into one just closed.
- An archived workspace stays in the switcher and in the list, marked and sorted last. Hiding it would read as deletion, and somebody has to be able to get back into it to bring it back.
- Jobs are not stopped. Pruning expired rows and settling sync candidates change no knowledge, and a workspace whose maintenance stops is a workspace that grows quietly forever.

## Alternatives considered

**A flag the interface honours.** Cheapest, and worthless: an agent with a token writes straight past it. The whole reason to archive is that the writers are not watching.

**Delete the workspace.** Simple and final. It throws away the thing the product exists to keep, and there is no undo for a mistake.

**Revoke every credential and remove every member instead.** Achieves silence without a new state, and destroys the information you archived the workspace to keep: who had reached it, and with what standing. Undoing it means reconstructing memberships by hand, so it is not reversible in any useful sense.

**Freeze administration too.** Tidier to describe: archived means nothing changes at all. Rejected because the way back is administration, so it would make archiving one-way — and a one-way archive is a deletion with a nicer name.
