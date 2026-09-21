# Workspace Git Repository

This document defines the canonical on-disk representation of a workspace. It is the contract that makes Knoverge data portable: a person with only this repository and a text editor must be able to understand the knowledge.

See ADR 0002 for the rationale.

## 1. Layout

```text
<repo>/
├── README.md                 generated once; explains the layout
├── taxonomy.yaml             full category tree, written on every taxonomy change
└── knowledge/
    ├── projects/
    │   └── pixel-brisbane/
    │       └── architecture/
    │           ├── authentication-strategy.md
    │           └── database-choice.md
    ├── career/
    │   └── australia/
    │       └── visa-timeline.md
    └── _uncategorised/
        └── loose-note.md
```

Rules:

- an item lives at `knowledge/<primary category slug path>/<item slug>.md`;
- items with no category live under `knowledge/_uncategorised/`;
- category directories contain only item files and child category directories;
- no other files are written into `knowledge/`;
- attachments are never stored in the repository.

## 2. Item slug

The item slug is assigned at creation from the title (lowercase, ASCII-transliterated, hyphen-separated, max 80 characters).

On collision inside the same directory the server appends `-2`, `-3`, and so on.

The slug is stored in `KnowledgeItem.slug` and **does not change when the title changes**. It changes only through an explicit rename operation. This keeps paths stable for casual title edits.

Changing the primary category moves the file. Git records the rename; the item id is unchanged.

## 3. Frontmatter

```yaml
---
id: kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3
title: Authentication strategy
type: decision
status: active
language: en
categories:
  - projects/pixel-brisbane/architecture   # first entry is the primary category
  - projects/pixel-brisbane/product
tags:
  - auth
review: human_reviewed
evidence: source_backed
disputed: false
valid_from: 2026-09-19T09:20:00Z
valid_until: null
observed_at: null
created_at: 2026-09-19T09:00:00Z
updated_at: 2026-09-19T09:20:00Z
sources:
  - type: web_url
    uri: https://example.com/spec
    role: primary
  - type: agent_session
    client: claude-code
    session_id: sess-42
    role: supporting
relations:
  - type: supersedes
    target: kn_01J8Z2A0C1D2E3F4G5H6J7K8M9
  - type: implements
    target: kn_01J8Z1B9C8D7E6F5G4H3J2K1M0
    valid_from: 2026-09-19T00:00:00Z
external:
  source_system: claude-code
  external_key: github.com/example/project-x:architecture/authentication
summary_of:                 # only for type = summary
  - kn_01J...@rev_01J...
---
```

Field rules:

- `id`, `title`, `type`, `status`, `language`, `created_at`, `updated_at` are required;
- `categories` are slug paths, never ids; the first entry is the primary category;
- `sources` and `relations` are a portable projection of PostgreSQL data; PostgreSQL remains the queryable authority, but the two must agree and the integrity checker verifies it;
- `relations.target` is a portable item id; item ids are stable across export/import;
- no secrets, tokens, embeddings, or user emails;
- keys are written in the order above; unknown keys are rejected by the parser;
- a field with nothing in it is left out rather than written as an empty list, so the file stays readable — except `valid_from`, `valid_until` and `observed_at`, which are written as `null`, because for an instant "unset" and "explicitly none" are not the same statement;
- item ids and revision ids are ULIDs in Crockford base32, which has no `I`, `L`, `O` or `U`.

Every field in frontmatter is part of the revision. Changing any of them creates a new revision and a Git commit.

## 4. Body

The Markdown body is the knowledge itself, written for humans. A title heading is not required in the body; `title` in frontmatter is canonical.

## 5. Content hash

`content_hash` identifies the knowledge content independent of metadata.

```text
content_hash = "sha256:" + hex(sha256(utf8(normalise(title) + "\n" + normalise(body))))
```

Normalisation:

1. Unicode NFC;
2. CRLF and CR to LF;
3. strip trailing whitespace on every line;
4. collapse a run of blank lines to one;
5. exactly one trailing newline.

Normalisation already leaves exactly one trailing newline, so the single `\n`
joining the two parts is the blank line between them. An independent
implementation must produce the same bytes: this is the value agents compare
during reconciliation, and a digest that differs by one newline is a digest
that never matches.

Frontmatter is excluded, so recategorising, retagging, or changing review state does not change `content_hash`. This is what agents compare during reconciliation (`candidate_content_hash`). It is distinct from `source_content_hash`, which fingerprints an agent's raw source material.

A revision additionally has `frontmatter_hash` (sha256 of the canonical YAML serialisation) so metadata-only revisions are distinguishable.

## 6. Taxonomy file

An empty field is left out rather than written as `null` or `[]`: the file is meant to be read by a person, and a page of empty lists is not.

```yaml
version: 42
updated_at: 2026-09-19T09:20:00Z
categories:
  - slug: projects
    name: Projects
    status: active
    children:
      - slug: pixel-brisbane
        name: Pixel Brisbane
        description: ...
        aliases:
          - Pixel
        children:
          - slug: architecture
            name: Architecture
            description: Canonical technical architecture ...
```

`taxonomy.yaml` is rewritten in the same commit as any taxonomy mutation and in the same commit as an item move caused by a category merge.

## 7. Deletion and restore

Logical delete removes the file from the working tree in a commit and records the last revision in PostgreSQL. History keeps the content.

Restore re-adds the file from the last revision in a new commit and produces a new revision.

Superseded and archived items stay in the tree with their `status`.

## 8. Commits

One domain operation equals one commit. A commit may touch several files (item move plus `taxonomy.yaml`, a supersession touching two items, or a category merge moving many items).

```text
Author:    <actor display name> <act_01J...@knoverge.local>
Committer: Knoverge <system@knoverge.local>

supersede(fact): Backend database

Knoverge-Operation: op_01J...
Knoverge-Workspace: ws_01J...
Knoverge-Actor: act_01J...
Knoverge-Agent: ag_01J...
Knoverge-Proposal: prop_01J...
Knoverge-Change: kn_01J...NEW@rev_01J...A create
Knoverge-Change: kn_01J...OLD@rev_01J...B superseded_by
Knoverge-Taxonomy-Version: 43
```

Subject prefixes: `create`, `update`, `delete`, `restore`, `move`, `supersede`, `taxonomy`, `import`. An item's subject carries its type, as `create(decision): Authentication strategy`.

An item with no category lives at `knowledge/_uncategorised/<slug>.md`, so every item has a path and the file layout never has a hole in it.

`Knoverge-Change` appears once per revision, so a supersession carries two and recovery writes both or neither. `Knoverge-Category` is present on a taxonomy commit, as `<category id> <create|update|move|archive|restore>`. The file carries the whole tree; this is the one thing it cannot say, because a path is not an identity and a rename makes that plain. `Knoverge-Change` is repeated once per revision produced by the commit, in the form `<item id>@<revision id> <change kind>`. `Knoverge-Taxonomy-Version` is present when the commit rewrote `taxonomy.yaml`. Together with the file contents these trailers let recovery rebuild every `KnowledgeRevision` row of the commit unambiguously.

What Git alone can restore: canonical knowledge, taxonomy snapshots and the revision topology. What it cannot restore: users, memberships, permissions, policy, proposals, review decisions, sync state and the audit ledger. A full restore needs the PostgreSQL backup as well.

Commits are not signed in MVP. GPG/SSH signing may be added behind configuration.

## 9. External edits

Editing the repository directly (outside Knoverge) is **unsupported in MVP**.

What the server enforces today: PostgreSQL records the commit that wrote each taxonomy version, and a write is refused when the branch no longer leads back to that commit. A repository that was lost, replaced, restored from an older backup, or rewritten with `reset`, `rebase` or `filter-branch` therefore stops accepting writes rather than stacking new history on a hole. Reachability is the test, not mere presence: an object a reset left behind would otherwise pass until garbage collection ran and fail afterwards, which is the same repository giving two answers.

What it does not enforce yet: a commit an operator added on top of HEAD is not noticed, because it does not contradict anything the database recorded. Recording and comparing HEAD, and the `knoverge integrity check` command that repairs a workspace the guard has locked, arrive in Milestone 9.

Knoverge stages only the paths the operation itself wrote, so an unrelated file left in the working tree is never folded into a domain commit, and a change that alters no canonical byte does not become a commit because something else was lying in the directory.

A later milestone adds an importer that validates externally created commits and records them as revisions with `source_type = git_commit`.

## 10. Repository README

The generated `README.md` in each workspace repository states:

- that the repository is managed by Knoverge;
- the layout above;
- that direct edits are not supported;
- where to find the Knoverge documentation.
