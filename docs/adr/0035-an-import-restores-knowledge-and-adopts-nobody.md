# 35. An import restores knowledge and adopts nobody

Date: 2026-09-29

Status: accepted

## Context

ADR 0034 settled what an export is: a git bundle of the workspace repository, a
manifest, and the attachments when asked for. This is the other end — what
happens when somebody hands that directory to another installation.

Three things have to be decided, and each has a wrong answer that looks
reasonable.

**How much of the history comes back.** The bundle carries every commit, so the
knowledge and its past are both in the file. PostgreSQL is where `knowledge.history`,
diffs and summary dependencies are read from, so an import that wrote only the
current state of each item would produce a workspace whose history exists on disk
and nowhere a reader can reach. "Every change is a revision and a commit" is the
first thing this product says about itself.

**Who the writes belong to.** The commits name actors of the installation that
made them — `act_01…`, with the display names in the manifest. The receiving
installation has its own people and its own agents, and none of them made these
writes.

**What happens when the workspace already holds knowledge.** An export carries
stable item ids (`GIT_REPOSITORY.md` section 3), so the same item can exist on
both sides at different revisions.

## Decision

**The history comes back.** The import walks the bundle's commits oldest first,
reads `Knoverge-Change` from each, and writes the item and the revision it names
— the same rebuild `db recover` does from a single commit, over the whole
history. A workspace that was imported reads like one that was used: `history`
answers, a diff between any two revisions works, and a summary knows what it was
made from.

**Actors are recreated, and are nobody here.** Each actor the manifest names gets
an actor in the new workspace carrying its kind and its display name, with no user
and no agent behind it. So `knowledge.created` still says who wrote it and the
interface still shows "Grigory Frolov", while nobody gains the ability to sign in,
hold a permission or write again. An import that attached these to local accounts
would be inventing consent; one that flattened them to a single "imported" actor
would throw away the provenance the export went to the trouble of carrying.

**Which ids survive, and which do not.** Item and revision ids do: they are the
knowledge, they are what `GIT_REPOSITORY.md` calls portable, and they are what
makes two workspaces holding the same id comparable. The workspace and its actors
get new ids, because they are this installation's rows about this installation's
workspace. The system actor is the one exception among actors: a workspace has
exactly one, and what the other installation's system did, this one's system is
the right name for.

Item ids being global has a consequence worth stating: **an export cannot be
imported into an installation that still holds those items.** That is the right
answer — it is a move, not a way to make a second copy beside the first — and the
import says which ids are taken rather than failing on a primary key halfway
through. Attachment ids survive for the same reason: an item made from a file
names the attachment in its frontmatter, so the rows have to exist before the
first revision that cites one.

**An import creates the workspace, or fills an empty one, and refuses the rest.**
Into a workspace that already holds knowledge it stops and says which one and how
many items it holds. That case is a reconciliation — the same session an agent
opens when it arrives with an inventory (Milestone 5) — and doing it silently
would be the blind insert the plan for this milestone names as the thing to avoid.

**The receiving ledger records the import as what it is.** Events are written for
the workspace being created and for each item, attributed to the person who ran
the command, with the source export named in the metadata. The exporting
installation's events do not come along and could not be verified here (ADR
0034); this workspace's chain starts with its own creation, which is the truth.

**Nothing else is created.** No agents, no credentials, no permissions, no policy
rules, no proposals. The receiving installation decides who may do what, and an
import that carried those would hand an agent's authority across a boundary
nobody checked.

## Consequences

Export and import together are a move rather than a copy of a machine: the
knowledge, its history, its provenance and its taxonomy arrive; the installation's
own arrangements stay where they were. An operator who imports has one more step —
granting their people and agents access — and that step is where the receiving
installation states its own rules, which is where it belongs.

Item and revision ids survive, so an export taken from the new installation and
compared with the old one is comparable item by item. That is what makes the
reconciliation case in the next part of this milestone tractable: two workspaces
holding the same id are holding the same item, and what differs is which revision.

An import is not idempotent and does not pretend to be: run twice into the same
target it refuses the second time, because the first left knowledge behind.
