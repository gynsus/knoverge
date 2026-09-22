# ADR 0016: A category path change moves the knowledge under it

- Status: Accepted
- Date: 2026-09-22

## Context

Rule 1 says canonical content stays readable and navigable without the application: items live at `knowledge/<category-slug-path>/<item-slug>.md`, and frontmatter references categories by slug path.

A taxonomy change commits `taxonomy.yaml` and nothing else. Renaming a category, moving one, or merging one into another rewrites category paths in PostgreSQL and leaves every item file where it was, with frontmatter naming a path that no longer exists.

After the first rename, somebody opening the repository without the application finds items filed under a directory no category claims, saying they belong to a category the taxonomy does not list. The database is right and the repository is wrong, which is the one direction rule 1 exists to prevent — the repository is the canonical copy.

This is not new. `update` with a new slug and `move` have always done it; `merge` made a third way in. It surfaced in an audit rather than in use because no workspace here has yet renamed a category with knowledge under it.

## Decision

**A taxonomy change that alters a category path also moves the item files under that path and re-renders their frontmatter, in the same commit.**

One commit carries `taxonomy.yaml`, the moved files and their rewritten frontmatter, so the repository is never between two states.

**It is not a new revision of the items.** The item's assertion, title, body and categories are unchanged; what changed is the name of a category it belongs to. Frontmatter is a portable projection of the database — rule 1 says so of sources and relations, and it is equally true of category paths — and re-rendering a projection because its source moved is not a change to the thing projected.

Three things follow from treating it as a revision, all bad. `knowledge_changes` is how agents synchronise, so one administrative rename would present a whole branch as changed and have every agent re-read it. An item's history would fill with revisions whose diff is a path. And the revision count, which `KNOWLEDGE_LIFECYCLE.md` treats as how often an assertion has been restated, would stop meaning that.

**Revision rows are not touched.** A revision records what was committed at its own commit, and `knowledge_history`, `knowledge_diff` and restore all read a past file with `readAt(revision.git_commit_hash, revision.markdown_path)`. Rewriting those paths would point history at files that were not there. Only `knowledge_items.markdown_path` follows the file, because that column answers "where is it now".

## Consequences

- The repository stays navigable. A directory under `knowledge/` always names a category the taxonomy lists, and an item's frontmatter always names the path it is actually filed under.
- `content_hash` is unaffected: it covers the title and the body, not the frontmatter. `frontmatter_hash` on the newest revision stops matching the working file, by design, because a later commit re-rendered the projection.
- The integrity check of Milestone 9 must therefore rebuild the expected frontmatter from the database as it is now, rather than comparing the working file against the newest revision's stored `frontmatter_hash`. Written down here because the check does not exist yet and the constraint would otherwise be discovered by it failing.
- A rename near the root of a large taxonomy rewrites every file under it in one commit, while the workspace write lock is held. That is the cost of the repository being the canonical copy; the alternative is a repository that disagrees with the database.
- Recovery replays the move from the commit, which already carries the old and new paths in the operation the taxonomy change recorded. Finding the affected items is a prefix query against `knowledge_items.markdown_path`, which is safe to run twice: after a successful run no item is left under the old prefix.
- Direct edits to the repository remain unsupported (`GIT_REPOSITORY.md` section 9). An item moved by hand into another category's directory will not have its frontmatter corrected by this, and the database will not know it moved.
