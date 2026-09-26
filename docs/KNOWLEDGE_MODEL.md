# Knowledge Model and Structuring Rules

## 1. Goal

The knowledge model must remain understandable to humans and predictable for agents.

Do not use one concept called "memory" for everything.

The system separates:

- type;
- category;
- tags;
- relations;
- provenance;
- temporal validity;
- review, evidence and dispute state;
- lifecycle status;
- language.

## 2. Knowledge types

Initial fixed type set:

### `fact`

A claim intended to describe reality.

Example:

> The project uses PostgreSQL 16.

### `decision`

A choice that was made.

Example:

> Redis will not be required for MVP.

### `instruction`

A durable directive.

Example:

> All production changes require review.

### `preference`

A stable preference of a user/team.

Example:

> Prefer Australian English for public-facing copy.

### `procedure`

A repeatable process.

Example:

> How to deploy the project on a VPS.

### `observation`

A recorded observation that may not be durable or fully verified.

Example:

> Search latency increased after the latest import.

### `episode`

A time-bounded event or work session.

Example:

> Claude Code attempted migration X and tests failed.

### `document`

A larger source/document represented inside the knowledge system as Markdown. When the document originates from an uploaded file, the item links to the attachment and to the original location. See ADR 0008.

## 2a. Granularity rule

One `fact`, `decision`, `instruction` or `preference` item represents **one independently updateable durable assertion or decision**.

Wrong:

```text
# Project architecture
uses PostgreSQL, uses Redis, uses S3, auth uses OAuth, deploys with Docker
```

When only Redis changes, the whole item would need supersession, new validity dates and re-review. Right: five items, each with its own history, validity and relations.

`document`, `procedure` and `episode` items may be long because they are source material or narratives, not atomic claims. Facts extracted from a `document` become separate items with a `derived_from` relation.

Agents receive this rule through the `knowledge_write_policy` prompt; reviewers may split oversized proposals with edit-and-approve.

### `insight`

A derived interpretation, hypothesis, or conclusion.

### `summary`

Derived material produced from one or more revisions.

## 3. Category vs type vs tag

Agents must understand these distinctions.

### Type answers

> What kind of knowledge is this?

One primary type per item.

### Category answers

> Where in the stable knowledge structure does this belong?

Categories are hierarchical, curated, and relatively stable.

Example:

```text
Projects
  Pixel Brisbane
    Architecture
    Product
    Marketing
  Home Heads Up
    Architecture
    Data Sources

Career
  New Zealand
  Australia
```

### Tag answers

> What lightweight labels help retrieve this?

Tags are flexible and do not need a hierarchy. They are workspace-scoped.

A tag is content rather than an identifier (ADR 0019): any script, spaces
inside, stored exactly as written. Two tags are the same tag when their
normalised forms agree — NFC, whitespace collapsed, trimmed, case folded — so
`PostgreSQL` and `postgresql` are one tag and the workspace keeps the spelling
it saw first. Control characters and commas are refused: the first are
invisible wherever a tag is shown, and the second is what the frontmatter, the
query string and the tag input all separate tags with.

Examples:

```text
oauth
postgres
migration
seo
urgent
```

### Relations answer

> How does this item connect to another specific item?

Example:

```text
decision A supersedes decision B
procedure C implements decision A
summary D derived_from fact E
```

## 4. Category schema

Each category contains:

```yaml
id: cat_01J...
slug: architecture
path: projects/pixel-brisbane/architecture
name: Architecture
description: Canonical technical architecture and architectural decisions for Pixel Brisbane.
parent_id: cat_01J...
status: active
aliases:
  - technical architecture
inclusion_guidance:
  - system components
  - architectural constraints
  - infrastructure decisions
exclusion_guidance:
  - implementation tasks with no durable architectural value
```

`slug` is unique among siblings. `path` is the slash-joined chain of slugs, unique per workspace, and is what appears in Markdown frontmatter and in the repository layout. Categories nest at most eight levels deep.

A slug is derived from the name unless one is given. Diacritics are stripped and Cyrillic is transliterated, so "Архитектура" becomes `arhitektura`. A name in a script with no transliteration keeps its name and receives a generated identifier such as `category-3f8a2b1c`, which the curator may replace.

Renaming a slug or moving a category rewrites the paths of its whole subtree in one statement, inside the same transaction as the taxonomy version bump and the ledger event. Archiving a category archives its descendants with it, and restoring it brings the same subtree back; a category cannot be restored while its parent is archived.

Statuses:

```text
proposed
active
merged
archived
rejected
```

Renaming a slug or moving a category moves every item file under it in one commit.

## 5. Category creation rules

An agent should propose a category only when all are true:

1. no existing category reasonably covers the material;
2. the new category is expected to contain multiple durable items;
3. it represents a stable subject area, not a one-off keyword;
4. a tag would be insufficient;
5. the proposed name is not merely a synonym of an existing category.

New category proposals include:

```json
{
  "name": "Data Sources",
  "parent_path": "projects/home-heads-up",
  "description": "External and internal data sources used by Home Heads Up.",
  "reason": "At least 14 durable knowledge items concern source ownership, refresh cadence and licensing.",
  "example_titles": [
    "BOM weather source",
    "Council waste collection source",
    "UV data source"
  ]
}
```

The server performs:

- exact slug/name check;
- alias check;
- optional semantic similarity check;
- policy evaluation.

Possible result:

```text
use_existing
proposal_created
created
```

## 6. Canonical item structure

Each item has one canonical current revision.

The full frontmatter contract, file layout and hashing rules are in `GIT_REPOSITORY.md`. Summary:

```yaml
id: kn_01J...
title: Authentication strategy
type: decision
status: active
language: en
categories:
  - projects/pixel-brisbane/architecture
tags:
  - auth
review: human_reviewed
evidence: source_backed
disputed: false
valid_from: 2026-09-19T09:00:00Z
valid_until: null
created_at: 2026-09-19T08:20:00Z
updated_at: 2026-09-19T09:00:00Z
sources: []
relations: []
```

Two more fields appear only when they have something to say: `superseded_by`,
on an item that was replaced, and `disputed_by`, on an item something
contradicts. Both are projections of a relation recorded on the other item, so
that a file read on its own answers the question it raises.

The Markdown body contains knowledge intended for human reading.

## 7. Lifecycle status

Item status:

```text
draft
active
superseded
archived
deleted
```

Deletion is logical from the current index.

History must remain available to authorised reviewers.

Disputes are not a status. They are expressed through the `disputed` flag and `contradicts` relations, so an item can stay `active` while it is under question.

## 8. Review, evidence and dispute state

Three orthogonal properties replace a single "trust" value (ADR 0009):

```text
review:   unreviewed | agent_reviewed | human_reviewed
evidence: none | source_backed | corroborated
disputed: true | false
```

- `review`: strongest review the current revision received. A new revision resets it to `unreviewed` unless a human committed it.
- `evidence`: `source_backed` when at least one source reference with a locator or hash exists; `corroborated` when two or more independent sources or agents support the claim. A stored hash proves the source bytes are unchanged, not that the claim is true.
- `disputed`: derived, never set. True while a live `contradicts` relation connects the item to another item — in either direction — that is still `active` and whose validity window overlaps this one's. There is no operation that sets it and none that clears it: a dispute ends when one side is superseded or deleted, when the relation is withdrawn, or when both claims are accepted and given the period each one holds for. ADR 0022 records why, and `KNOWLEDGE_LIFECYCLE.md` section 6 gives the mechanics.

Explicit human doubt is recorded as an item. Somebody who doubts a claim writes down what they doubt and relates it with `contradicts`, which says what the objection is, who made it and when — a boolean says none of that, and rule 15 already asks for one assertion per item.

Confidence is separate: a claim-level estimate from a source or agent, stored on proposals and source references.

A `trust_score` used for ranking in search and briefings is computed from review, evidence, dispute and freshness with configurable weights. It is never stored as canonical data.

## 9. Language

Every item has a `language` (BCP 47 primary subtag such as `en`, `ru`). It is set by the proposer, may be auto-detected when omitted, and drives the full-text search configuration.

A workspace has a default language used when nothing better is known.

## 10. Temporal validity

Where meaningful, support:

```text
valid_from
valid_until
observed_at
```

Example:

```text
Fact A:
backend = MySQL
valid_until = 2026-09-18

Fact B:
backend = PostgreSQL
valid_from = 2026-09-18
```

Do not destroy historically correct information solely because current state changed.

### Relation types

```text
supersedes
implements
derived_from
contradicts
duplicates
depends_on
relates_to
```

`superseded_by` is not one of them: it is `supersedes` read from the other end,
and storing both directions gives two rows that can disagree. A reader wanting
that view asks for relations pointing at the item. `disputed_by` is absent for
the same reason and carried the same way: as a frontmatter projection of the
`contradicts` relations pointing at an item (ADR 0015 and ADR 0022).

Relations are replaced whole, like tags, and removal is logical: a relation that
was once true is part of the history of both items. An item may not relate to
itself.

## 11. Provenance

Every knowledge item must be traceable to one or more source references.

Source types:

```text
human_input
agent_session
web_url
file
attachment
email
git_commit
external_system
other_knowledge_item
```

The source record stores identifiers and hashes where possible, and the
difference matters: a source with a locator or a hash is something somebody
else can go and check, and a source with neither is an assertion about where
something came from. Only the first makes an item `source_backed`.

Naming the agent is not a source. Who wrote an item is already recorded three
times — on the revision, in the ledger, and in the commit trailers — and
repeating it under `sources` would add a fourth copy of a fact while answering
nothing about what the claim rests on.

Sources are stored in PostgreSQL and mirrored into frontmatter. They are attached to the **revision** rather than to the item: which sources were cited is part of what a revision said, so an older revision keeps its own after the item moves on.

A source is deduplicated per workspace by whatever identifies it — a URI, or a record in another system — so citing one page from ten items is one row. A source with neither, such as a person saying something, is its own occurrence and is not deduplicated against anything.

## 12. Summaries

A summary is a knowledge item with:

```text
type = summary
summary_of = item id @ revision id list
generation metadata
stale boolean
```

A summary must never be the only surviving representation of source knowledge.

## 13. Structure returned to agents

Agents should be able to request a compact taxonomy manifest:

```json
{
  "taxonomy_version": 42,
  "categories": [
    {
      "id": "cat_01J...",
      "path": "projects/pixel-brisbane/architecture",
      "name": "Architecture",
      "description": "...",
      "item_count": 28,
      "subtree_item_count": 28,
      "updated_at": "...",
      "recent_key_items": []
    }
  ]
}
```

This representation is intentionally compact so an agent can reason about structure before fetching item contents. With `root_path`, `depth` and `include_recent_key_items` it serves as the hierarchical knowledge map for large workspaces.
