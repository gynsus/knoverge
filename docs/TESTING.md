# Testing Strategy

## 1. Test layers

Use:

- unit tests (Vitest);
- repository/database integration tests (Testcontainers PostgreSQL);
- Git-store integration tests (temporary repositories);
- HTTP API integration tests;
- MCP integration tests through the MCP SDK client;
- end-to-end browser tests for critical review flows (Playwright; see "What is not set up yet" below).

### What is not set up yet

There is no Playwright harness in the repository, so no change is held up waiting for one. A user interface change is covered by component tests and by the HTTP integration tests behind it until the harness exists.

## 2. Mandatory domain tests

### Optimistic concurrency

Scenario:

1. agent reads revision 3;
2. human creates revision 4;
3. agent attempts update based on revision 3;
4. operation must fail with `REVISION_CONFLICT`;
5. revision 4 must remain unchanged.

Sequentially is the easy half, and it is not the half that breaks. The check has
to be made against state nobody else can be changing, so each write path also
needs the concurrent case: two callers reading the same revision and writing at
the same moment, asserted as exactly one winner **and** a workspace that still
accepts writes afterwards. The second assertion is the one that matters — a
check made outside the workspace lock lets both callers through, and the loser
leaves behind a Git commit PostgreSQL never recorded, which blocks the workspace
until an operator resolves it. Sequential tests cannot see any of that.

### Idempotent proposal creation

Retrying the same idempotency key with the same payload returns the original result.

Same key + different payload fails.

### Duplicate check

- creating an item whose content hash exists returns `DUPLICATE_SUSPECTED`;
- repeating with `acknowledged_duplicate_ids` creates the proposal and records the acknowledgement;
- a distinct item passes without acknowledgement.

### Audit attribution

Every committed write has an event identifying its actor.

### Ledger hash chain

- each event's `event_hash` verifies with `KNOVERGE_LEDGER_KEY` against its canonical JSON and `prev_event_hash`;
- verification with a wrong key fails at the first event;
- modifying any stored event, deleting one, or reordering breaks verification at that point;
- concurrent writers cannot produce two events with the same `sequence`, and the sequence is gapless;
- no event row contains Markdown bodies, proposal payloads or credentials (schema-level test over fixtures).

### Change feed

- an agent with `events.read_own` still sees, through `knowledge_changes`, changes made by other actors within its read scope;
- changes outside the scope are absent; an item moved out of scope appears as `deleted`, moved in as `created`;
- the feed exposes no actor information;
- `after_sequence` paging is exact and repeatable.

### Policy defaults and denial

- `trusted` agent without an `allow_direct` rule gets `require_review`;
- `trusted` agent with a scoped rule commits directly inside the scope and requires review outside it;
- a denied command creates no proposal and produces a `command.denied` event.

### Supersession

- `knowledge_propose_supersede` produces one commit, two revisions, one relation, `status = superseded` and validity dates atomically;
- failure after the Git commit is recovered into the same end state.

### Scope stability

- renaming and moving a category keeps existing grants and rules effective;
- merging categories re-points selectors to the survivor;
- a new category created under an old path does not inherit old grants.

### Review attribution

Edit-and-approve must preserve:

- original proposer;
- reviewer;
- final revision.

Self-approval is refused.

### Logical deletion and restore

Deleted item disappears from normal search and from the repository tree, its history remains, restore creates a new revision.

### Summary staleness

Changing a source revision marks dependent summary stale.

### Briefing and bounded reads

- respects scope and readable categories;
- deterministic ordering by computed trust score, then freshness;
- abridges before dropping when over budget and sets `truncated`;
- `knowledge_get` with `max_chars`/`offset` returns consistent slices and `total_chars`.

### Search chunks

- long items split deterministically; short items yield one chunk;
- chunk boundaries are stable across identical revisions;
- search returns the item once with its best chunk.

## 3. Git repository tests

- file path follows `knowledge/<primary path>/<slug>.md`;
- slug collision produces `-2`;
- title change does not move the file; category change does;
- `taxonomy.yaml` is rewritten in the same commit as taxonomy changes and category merges;
- frontmatter round-trips byte-for-byte through parse/serialise;
- `content_hash` is stable across CRLF/LF, trailing whitespace and NFC/NFD input, and excludes frontmatter;
- commit trailers allow rebuilding every revision row of a multi-item commit (supersession, category merge);
- unexpected external HEAD blocks writes.

## 4. Git/PostgreSQL failure tests

Simulate failure:

- before Git commit;
- after Git commit but before revision row;
- after revision row but before final event;
- during recovery.

Integrity repair must leave a deterministic state.

## 5. Reconciliation tests

### Exact external match

Same external key with unchanged `source_content_hash` => `exact_known`, final immediately.

### Content hash match

Same `candidate_content_hash`, same type and primary category => `exact_known`; same hash but different type or category => `likely_match` with `match_reason = content_hash`.

### Freshness needs lineage

A candidate with a recent `source_modified_at` but no external key and no previous mapping is never `server_copy_stale`.

### Likely semantic match

Similar abstract/title/category should return candidate match, not auto-overwrite; classification starts `provisional` and becomes `final` after the job.

### Server newer

Known previous sync + canonical updated later => `agent_copy_stale`.

### Agent newer

Known previous sync + source modified later => candidate for `server_copy_stale`, but still require canonical comparison.

### Ambiguous

Two plausible canonical matches => `ambiguous`.

### Retry

Resubmitting the same `client_candidate_id` must not duplicate sync candidates; candidates without `external_key` are accepted.

### Resume

Interrupted sync can continue using the same session until expiry.

### Incremental

`knowledge_changes` after a checkpoint returns exactly the canonical changes since the checkpoint, including those made by other actors.

## 6. Security tests

- revoked agent token fails immediately;
- token bound to workspace A cannot read workspace B;
- scoped agent cannot enumerate restricted category through taxonomy, index, search, briefing or events;
- read-only agent cannot create proposal;
- propose-only agent cannot approve its proposal;
- trusted agent's write is direct only where a rule allows it;
- token never appears in logs;
- prompt/content cannot modify ACL;
- login lockout after repeated failures;
- CSRF token required for browser mutations.

## 7. Contract tests

For every tool, through both MCP and HTTP:

- schema validation;
- authentication;
- permission denial;
- success result;
- stable error code and HTTP status mapping;
- request attribution;
- tool name matches `^[a-z][a-z0-9_]*$`.

## 8. Internationalisation tests

- `ru` catalogue has every key present in `en`;
- review, evidence and dispute labels are translated;
- no untranslated string literals in `apps/web` (lint);
- Russian plural forms render correctly for sample counts;
- FTS uses the `russian` configuration for `language = ru` items and finds stemmed matches.

## 9. Performance targets

Initial non-binding targets for a single modest server:

```text
workspace_manifest: p95 < 200 ms
taxonomy_list: p95 < 300 ms
knowledge_get: p95 < 300 ms
knowledge_briefing (subtree of 200 items): p95 < 500 ms
lexical search: p95 < 750 ms at 100k items
inventory exact-match batch of 100: p95 < 1 s
```

Do not sacrifice correctness for these targets.

## 10. Timeouts are a backstop, not a budget

A test's timeout is not the time its waits are allowed to take. Vitest's default
is five seconds, and a suite whose waits are also budgeted at five seconds fails
under load on the assertion nobody was looking at rather than on the one that
was unmet.

Every package that touches something real says so:

- `packages/db` and `apps/server` start a PostgreSQL container, so their tests
  get two minutes and their hooks three;
- `packages/git-store` drives a real repository and every operation is a `git`
  process, so its tests get thirty seconds;
- `apps/web` gives one `findBy*` five seconds and the test itself twenty, so a
  slow wait fails naming what was missing rather than that time ran out.

Each of those numbers was set after a suite failed on a loaded machine and
passed on a rerun. A test that passes alone and fails in the suite is usually
this, not a race.

## 10. Test fixtures

Create deterministic fixtures:

- two workspaces;
- one user with memberships in both, one user with one;
- read-only agent, propose-only agent, trusted writer;
- hierarchical taxonomy;
- English and Russian items;
- superseded fact;
- conflicting facts;
- stale summary;
- completed previous sync;
- a broken-chain ledger fixture for the integrity checker.
