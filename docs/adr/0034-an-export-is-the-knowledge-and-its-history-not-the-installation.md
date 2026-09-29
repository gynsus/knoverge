# 34. An export is the knowledge and its history, not the installation

Date: 2026-09-29

Status: accepted

## Context

`knoverge backup` already writes a database dump, an archive of the data
directory and a manifest, and `knoverge restore` puts them back. That answers one
question — this installation died, bring it back — and Milestone 13 asks a
different one: take what this workspace knows somewhere else.

They are not the same file. A backup is a dump of PostgreSQL for a matching major
version, keyed to this installation's `KNOVERGE_LEDGER_KEY`, carrying agents,
credentials, permissions, sessions, idempotency records and jobs. Restoring it
into another installation would mean adopting somebody else's credentials, and
verifying its ledger would mean having their key. It is the right answer to the
wrong question, and offering it as "export" would be telling an operator their
knowledge is portable when what they hold is a copy of a machine.

The requirement behind the milestone is plainer. A self-hosted product is asked
"can I take my knowledge and leave", and the answer has to be short.

## Decision

An export is a directory holding a **Git bundle of the workspace repository**, a
**manifest** describing what was taken, and, when asked for, the **attachments**
those files refer to. Nothing else.

The bundle is the whole of it. The repository already carries the knowledge in
Markdown with the frontmatter that describes it, the taxonomy in `taxonomy.yaml`,
sources and relations as a portable projection, and — in the commit trailers —
which item and which revision each change was, which is what `db recover` already
rebuilds PostgreSQL from. A bundle is that repository and every commit in it, in
one file that `git clone` opens.

**What the manifest adds** is what the files cannot say: the workspace's slug,
name and default language; the format version; when it was taken and by what;
where the ledger stood; and the display name and kind of each actor the commits
name, so an import can say "Grigory Frolov" where a trailer says `act_01…`. No
addresses, no credentials, no tokens — an export is meant to be handed to
somebody.

**What it deliberately leaves out**, and why each is not an oversight:

- **Agents, credentials, permissions and policy rules.** Who may write in this
  installation is a statement about this installation. An import that carried
  them would hand an agent's authority across a boundary nobody checked.
- **Proposals, sync sessions and jobs.** Work in flight belongs to the installation
  doing it. A proposal is a question asked of a particular reviewer.
- **The event ledger.** Its chain is keyed with `KNOVERGE_LEDGER_KEY`, which never
  leaves the environment, so events verified here cannot be verified there, and
  writing them into another workspace's chain would be inventing history rule 4
  exists to prevent. `knoverge audit export` already writes the ledger as
  evidence, and evidence is what it stays.
- **Embeddings and search indexes.** Derived, and rebuilt from canonical data by
  whatever model the receiving installation has. Carrying them would carry one
  model's opinion as if it were the knowledge.

**Attachments are included when asked for and named either way.** The files are
not in Git and cannot be rebuilt from anything (ADR 0008), so an export without
them leaves items whose sources point at nothing. They are also the part that
makes an export gigabytes, so `--attachments` is a choice — and the manifest lists
every attachment the workspace holds whether or not the bytes came along, so an
import can say what is missing rather than discovering it later.

## Consequences

An export is readable without this product: `git clone` the bundle and read
Markdown. That is the same promise rule 1 makes about the repository, in one file
somebody can copy to a disk.

An import (the next part of this milestone) restores knowledge, revisions,
categories and provenance, and creates nothing else: the receiving installation's
own agents, permissions and policy decide what happens next. The ledger of the
receiving workspace records the import as what it is — writes made by the person
who ran it.

Two installations cannot end up with the same item at two different revisions by
accident, because item ids are stable across export and import (`GIT_REPOSITORY.md`
section 3) and an import into a workspace that already holds an id is a
reconciliation, not an overwrite. That is the other half of this milestone and is
where the sessions from Milestone 5 do the work.

`knoverge backup` is unchanged and remains the answer to the other question. The
documentation says which is which in one line, because an operator reaching for
the wrong one finds out late.
