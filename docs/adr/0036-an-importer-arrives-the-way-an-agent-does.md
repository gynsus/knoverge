# 36. An importer arrives the way an agent does

Date: 2026-09-29

Status: accepted

## Context

Milestone 13 asks for importers — a folder of Markdown, an Obsidian vault, a
ChatGPT export, generic JSON — and states the requirement in the same line:
"producing reconciliation sessions rather than blind inserts".

The reason is the one Milestone 5 was built for. A folder somebody points at is
not empty of things the workspace already knows. Half of it is probably a
restatement of what is there, a third is the same note saved twice under two
names, and the rest is new. An importer that inserted all of it would turn one
afternoon's convenience into a workspace nobody can search, and the duplicate
detection, the classification and the review queue that exist for exactly this
would be bypassed by the one path that needs them most.

`knoverge import` is not that path. It reads an export this product wrote, whose
items carry their own ids and their own history, into an installation that does
not hold them (ADR 0035). Nothing has to be matched because nothing can collide.
A folder of somebody's notes is the opposite case in every respect.

## Decision

**An importer is an agent.** It opens a sync session with `sync_begin`, submits a
compact inventory, and reads back what the workspace made of each candidate —
the same three steps, through the same service, that an agent connecting for the
first time takes. The operator names which agent on the command line.

That settles several things at once, and none of them has to be decided again:
the policy already says whether that agent may write directly or must propose
(rule 5, rule 14); the duplicate check already runs; the classifications already
have a screen; and a second run of the same importer over the same folder is a
resumed session rather than a second copy of everything, because candidates are
keyed by their source.

**The source key is the path inside the folder.** It is what is stable about a
file across runs — a title changes, a body changes, and the path is what the
person filing it chose. `source_system` and `source_namespace` name the tool and
the folder, so two vaults imported into one workspace do not look like one vault
that changed its mind.

**The importer submits an inventory and stops.** It does not create proposals in
the same breath. What comes back is a session a person can read: this many the
workspace already has, this many look like something it has, this many are new.
Turning that into proposals is a decision somebody makes after reading it, and
the next part of this milestone is where the command to do it lives.

**Nothing is read into the workspace to decide any of this.** The inventory
carries a title, a type, the fingerprint of the file and the fingerprint of the
normalised text — never the body. A folder of ten thousand notes is ten thousand
short records, and the bodies of the ones that turn out to be new are sent when
they are proposed.

## Consequences

Every importer is the same shape, so the ones after the first are a parser and
nothing else: read files, produce candidates, hand them to the session. An
Obsidian vault differs from a folder of Markdown in what its frontmatter means
and what a wikilink is, not in how it arrives.

An importer cannot write knowledge that nobody reviewed unless the agent it runs
as is one the workspace already trusts to. An operator who wants a folder to land
directly grants that agent `allow_direct` and knows they did; the default leaves
every new item in the queue.

A folder imported twice is classified twice and inserted once, because the second
run's candidates carry the same source keys and hashes. That is what makes an
importer safe to point at a directory that grows.
