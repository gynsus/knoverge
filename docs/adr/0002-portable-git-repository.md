# ADR 0002: Self-describing workspace Git repository

- Status: Accepted
- Date: 2026-09-19

## Context

Rule 1 of the architecture says canonical content must remain readable without the application. The initial specification stored categories in frontmatter as database ids (`cat_01...`), kept the taxonomy only in PostgreSQL, and kept relations and source references only in PostgreSQL. A repository exported from such a system could not be interpreted without the database, which defeats the rule.

The file layout inside the repository and the exact definition of `content_hash` were also undefined, although both are load-bearing for reconciliation.

## Decision

1. Items are stored at `knowledge/<primary category slug path>/<item slug>.md`. Uncategorised items go to `knowledge/_uncategorised/`.
2. Frontmatter references categories by slug path. Database ids for categories never appear in Markdown.
3. The taxonomy is written to `taxonomy.yaml` at the repository root in the same commit as any taxonomy change.
4. Sources and relations are mirrored into frontmatter. PostgreSQL remains the queryable authority; the integrity checker verifies agreement.
5. The item slug is derived from the title at creation and is stable across title edits; only an explicit rename changes it. Changing the primary category moves the file.
6. Every change to an item, including metadata-only changes, is a new revision and a Git commit. There are no database-only revisions.
7. `content_hash` covers normalised title and body only, excluding frontmatter, so that metadata edits do not invalidate hashes held by agents. A separate `frontmatter_hash` identifies metadata.
8. Commits carry `Knoverge-*` trailers sufficient to rebuild PostgreSQL revision rows from Git. A commit that produces several revisions (supersession, category merge) carries one `Knoverge-Change: <item>@<revision> <kind>` trailer per revision and `Knoverge-Taxonomy-Version` when `taxonomy.yaml` changed. Git alone restores knowledge and revision topology, not users, permissions, proposals or the ledger.
9. Direct edits to the repository are unsupported until an importer exists; an unexpected HEAD blocks writes.

Details are in `docs/GIT_REPOSITORY.md`.

## Consequences

### Positive

- A repository clone is a complete, human-navigable knowledge base.
- Recovery from Git alone is possible.
- Agents and server compute the same hash.
- Category-based directories match how people browse.

### Negative

- Category moves and merges generate file renames and, for large merges, large commits.
- Relations and sources are duplicated between PostgreSQL and frontmatter and must be kept consistent.
- Slug stability rules add a rename operation.

## Rejected alternatives

### Flat `items/<id>.md` layout

Stable paths, but a repository nobody can browse. Rejected because human navigability is a product principle.

### Metadata-only changes without Git commits

Fewer commits, but Git and PostgreSQL would diverge and rollback semantics would become ambiguous. Rejected.

### Hash over the whole file including frontmatter

Simpler, but every recategorisation would make every agent's copy look stale. Rejected.
