# 37. A commit somebody made by hand is adopted, not refused

Date: 2026-09-29

Status: accepted

## Context

Rule 1 says the canonical knowledge is Markdown in a Git repository, readable and
editable without this product. People take that literally, which is the point:
somebody clones the workspace repository, fixes a typo in forty files with an
editor, and commits.

Until now the product's answer to that was a finding. `knoverge integrity check`
reports `head_unknown` — "the branch is at a commit no revision and no taxonomy
version was written by — somebody committed by hand" — and stops there. The
workspace is then in a state the product calls wrong and the person calls
finished: the file says one thing, the database says another, and the only ways
out were to revert the commit or to edit every item again through the product.

That is rule 1 with a footnote nobody agreed to. If the repository is canonical,
a commit in it is knowledge, and the database is the index that has to catch up.

## Decision

`knoverge adopt-commits` reads the commits the database does not know about,
oldest first, and writes the revisions they describe.

**A commit with no trailers is still a commit.** An external one carries no
`Knoverge-Change`, so there is nothing to read the item and revision ids out of.
The file itself is what says: the frontmatter carries the item's id, which is what
`GIT_REPOSITORY.md` calls portable and what makes a file identify itself. A file
whose id names an item this workspace holds is an update of it; one whose id is new
is a create; one with no id, or an id that will not parse, is reported and skipped,
because inventing an id for somebody's file would be inventing the thing the file
was supposed to say.

**The revision id is new.** Nothing in an external commit proposes one, and a
revision id is this installation's record of a change rather than a property of the
text.

**It is the system actor's write.** The person who made the commit is in the Git
author, which the revision keeps by keeping the commit; the actor is the
installation, because the installation is what noticed. The events say `adopted`,
so the feed does not read as if somebody used the product.

**Taxonomy comes from the file, not from a guess.** A commit that changed
`taxonomy.yaml` is applied as the tree that file now holds, the same way an import
restores one (ADR 0035). A category that disappeared from the file is archived
rather than deleted: a delete would take items with it, and "this line is gone"
does not say that was meant.

**It refuses a repository it cannot line up with.** If the newest commit the
database knows is not an ancestor of the branch, somebody rewrote history — and
adopting on top of a rewritten history would attach this workspace's record to
commits that no longer say what it thinks they said. That is `integrity check`'s
unrepairable case and stays one.

## Consequences

Editing the repository directly becomes a supported way to work rather than a
thing the checker complains about: clone, edit, commit, adopt. That is what rule 1
promised and what ADR 0002 chose Git for.

The review queue is not involved. A person with access to the repository on the
server already has more power than any proposal grants, so routing their commits
through review would be theatre — and rule 5 is about agents, which cannot reach
the filesystem. The events record what happened, which is what makes it
answerable.

`head_unknown` stops being a dead end: the finding now names the command that
resolves it, and a workspace where somebody committed by hand comes back to
agreement instead of staying broken until a backup is restored.
