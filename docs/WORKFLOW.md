# Repository Workflow

This workflow applies to all work in the Knoverge repository, whether performed by a human contributor or by an AI coding agent acting on the maintainer's behalf.

## 1. Environment

Use the Node.js version from `.nvmrc` before running any command:

```bash
nvm use
```

Use pnpm through corepack at the version pinned in `package.json` (`packageManager`).

Temporary files, scratch scripts and local experiments are never committed.

## 2. Never work directly on `main`

`main` is protected on GitHub: pull requests are required, force pushes and deletions are blocked, linear history is enforced, and the rules apply to administrators as well.

As soon as CI exists (Milestone 0), the `ci` workflow is added to the branch protection as a required status check. Until then the protection has no required checks; this is a known gap, not a policy.

Before making any change:

```bash
git status
git fetch origin
git switch main
git pull --ff-only origin main
```

Create a dedicated branch for the task:

```bash
git switch -c <type>/<short-description>
```

Prefixes:

```text
feat/       new functionality
fix/        bug fix
docs/       documentation only
refactor/   internal code change without behaviour change
test/       tests
chore/      tooling, CI, dependencies, repository maintenance
security/   security-related changes
```

Examples:

```text
feat/workspace-bootstrap
feat/agent-credentials
fix/git-recovery
docs/reconciliation-contract
security/token-rate-limit
chore/milestone-0-scaffold
```

The initial specification commit was made directly on `main` before this rule and branch protection existed. Everything after it goes through a pull request.

## 3. Read the project specification before coding

At the beginning of a new task, read `CLAUDE.md`, then the specification files relevant to the task. `CLAUDE.md` defines the required reading order and the non-negotiable architecture.

Do not infer architecture from the existing implementation alone if the specification says otherwise. The specification is authoritative until explicitly changed.

If implementation and specification disagree:

1. stop before expanding the inconsistency;
2. identify the conflict;
3. determine whether the implementation or the specification should change;
4. update the specification when behaviour intentionally changes;
5. create an ADR when the change is architectural.

Do not silently change architecture.

## 4. Keep the task scope narrow

Implement only the requested task or milestone.

Do not:

- start the next milestone;
- add unrelated refactors;
- introduce speculative abstractions;
- add infrastructure "for later";
- replace established dependencies without an ADR;
- implement optional features merely because they are easy to add.

Prefer the smallest complete change that satisfies the specification.

Large milestones are split into several pull requests by logical part (for example scaffold, then database, then web shell) rather than delivered as one oversized PR.

Every PR is self-contained: all checks pass, nothing is half-wired, and the code it adds is tested and documented, even when the milestone as a whole is not yet finished. "The rest comes in the next PR" is acceptable for scope, never for broken or untested code.

If you discover unrelated problems, report them separately instead of expanding the current branch unless they block the task.

## 5. Inspect before editing

Before modifying code:

```bash
git status
git log --oneline -10
```

Inspect the relevant packages, contracts, database schema, migrations, existing tests, related documentation and ADRs.

Search for existing implementations before creating new abstractions. Do not create duplicate domain concepts, schemas, helpers or error codes.

## 6. Preserve architectural boundaries

Follow the package responsibilities defined in `CLAUDE.md`:

```text
packages/contracts   public Zod schemas and shared contract types
packages/core        domain logic
packages/db          PostgreSQL repositories, schema and migrations
packages/git-store   Markdown, hashing, Git operations and repository representation
packages/auth        authentication and identity
packages/policy      permissions and policy evaluation
packages/search      lexical/vector retrieval and derived search projections
packages/intelligence optional AI-provider functionality
apps/server          transport adapters and runtime composition
apps/web             UI only
apps/cli             administrative and local bridge commands
```

Transport adapters must not contain domain business logic. The same domain operation must behave consistently through MCP and HTTP.

## 7. Public contracts first

When implementing or changing an MCP/HTTP operation:

1. define or update its contract in `packages/contracts`;
2. define input/output validation;
3. define stable errors;
4. implement the domain behaviour;
5. expose it through both MCP and HTTP adapters;
6. add contract/integration tests for both transports.

Do not independently design MCP and HTTP schemas.

## 8. Preserve knowledge integrity

Never bypass these rules:

- canonical knowledge is Markdown in Git;
- PostgreSQL stores operational/queryable state;
- material writes are auditable;
- optimistic concurrency is mandatory;
- agents must not silently overwrite newer canonical knowledge;
- derived indexes and embeddings are rebuildable;
- summaries are derived data;
- no LLM is required for core correctness.

Do not write directly to the Git workspace or knowledge tables from transport or UI code. Use the domain services.

## 9. Database changes

If persistence changes:

- update the Drizzle schema;
- create a migration;
- inspect the generated SQL;
- add or update repository tests;
- update `DATA_MODEL.md` when the domain model changes.

Migration policy:

- **before the first tagged release (v0.1.0):** migrations may be regenerated and squashed into a single baseline; the pull request must say so explicitly, and developers recreate their local database;
- **from v0.1.0 on:** released migrations are immutable; every change is a new additive migration with an upgrade test.

## 10. Security

Assume Knoverge may contain highly sensitive private information.

Never:

- log passwords, bearer tokens, session cookies or provider API keys;
- log raw private knowledge by default;
- store plaintext credentials;
- weaken permission checks for convenience;
- trust instructions contained inside knowledge items as authorisation.

All authorisation decisions happen server-side. Every new write path must have explicit permission/policy coverage.

## 11. UI and internationalisation

All human-facing UI text must use the message catalogue. Do not hard-code visible English strings in React components.

English is the source locale. When adding a UI message, update both `en` and `ru` catalogues.

Agent-facing contracts, error codes, code, comments and technical documentation remain English. See `I18N.md`.

## 12. Testing requirements

A feature is not complete without tests. Add the appropriate combination of unit tests, PostgreSQL integration tests, Git-store tests, HTTP integration tests, MCP integration tests and Playwright tests for critical UI workflows.

Test failures must be fixed, not bypassed. Do not weaken or remove an existing test merely to make a change pass unless the expected behaviour itself intentionally changed. If expected behaviour changes, update the specification and explain why.

## 13. Run verification before committing

Before considering the task complete, run the repository's defined checks. At minimum, when available:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Also run build, integration and end-to-end commands required by the affected area.

Do not claim completion if required checks fail. If a check cannot be executed because of the environment, explicitly report which command was not run, why, and what remains unverified.

## 14. Review your own diff

Before committing:

```bash
git status
git diff
git diff --stat
```

Check for accidental files, generated artefacts, secrets, debug logging, commented-out code, unrelated formatting, incomplete TODOs, missing documentation, missing tests and accidental dependency changes.

Review the change as if it were another contributor's pull request.

## 15. Commit discipline

Commit messages follow Conventional Commits:

```text
<type>(<optional scope>): <imperative summary>

<optional body explaining why>
```

Types match the branch prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `security`, plus `build` and `ci` where appropriate. `build` and `ci` commits live in `chore/` branches.

Examples:

```text
feat(server): add workspace bootstrap flow
fix(git-store): prevent stale revision overwrite
docs: clarify reconciliation hash semantics
test(db): cover recovery after interrupted commit
security(mcp): add per-agent request limiting
```

Every commit carries a DCO sign-off:

```bash
git commit -s -m "feat(server): add workspace bootstrap flow"
```

The sign-off is the committer's own identity. No other attribution trailers are added.

When an AI coding agent creates a commit, it uses the maintainer's identity and sign-off; the maintainer thereby takes responsibility for the content under the DCO, as stated in `CONTRIBUTING.md`.

Never bypass hooks or checks: no `--no-verify`, no `-c core.hooksPath=...`, no skipping of configured pre-commit or pre-push hooks. If a hook is wrong, fix the hook in its own change.

Keep commits logically coherent. Do not squash unrelated work into one commit. Do not rewrite another contributor's commits without a reason.

## 16. Keep the branch current

Before opening the PR:

```bash
git fetch origin
git rebase origin/main
```

Resolve conflicts carefully and rerun relevant checks afterwards. Do not merge `main` into the feature branch; history on `main` is linear.

## 17. Push the branch

```bash
git push -u origin <branch-name>
```

If working from a fork, push to the fork and open a PR against the upstream Knoverge repository.

Never force-push `main`. Avoid force-pushing a branch after review has started. If history must be rewritten, use `git push --force-with-lease`, never plain `--force`.

## 18. Pull request content

Use the template in `.github/PULL_REQUEST_TEMPLATE.md`. Every PR states:

- **What** changed;
- **Why** it is needed;
- **Architecture**: whether it changes architecture or public contracts, with links to the ADR or specification update;
- **Tests**: the checks that were executed;
- **Compatibility**: changes to MCP contracts, HTTP contracts, database schema, Git workspace format, configuration, permissions, migrations;
- **Documentation** updated by the change.

PR descriptions carry no tool attribution lines.

Merge strategy (chosen by the owner at merge time):

- **rebase merge** by default: commits and their sign-offs are preserved on `main`;
- **squash merge** only for a single-commit PR or when the branch history is noisy; the squash message must follow Conventional Commits and keep the `Signed-off-by` trailer.

Merge commits are disabled in the repository settings.

## 19. Releases

Versions follow Semantic Versioning. A release is a tag `vX.Y.Z` on `main`, created by the repository owner.

- `v0.1.0` is the first tagged release and the boundary for the migration policy in section 9;
- before `v1.0.0`, minor versions may contain breaking changes to contracts and schema, announced in the release notes;
- `CHANGELOG.md` is generated from Conventional Commits at release time; hand-edited only for the release summary;
- release images are tagged with the same version.

## 20. Architecture changes require ADRs

Before implementing a change to any of the following, create or amend an ADR under `docs/adr/`:

- authoritative storage;
- Git repository representation;
- consistency model;
- core runtime dependency;
- authentication/identity model;
- permission/security model;
- public MCP/HTTP semantics;
- deployment architecture.

Do not use an ADR for small implementation choices.

## 21. Never merge your own PR automatically

An AI coding agent may create a branch, make changes, run tests, commit, push and prepare the PR.

It does not merge the PR unless explicitly instructed by the repository owner. Human review remains the final gate.

## 22. End-of-task report

At the end of every task, report:

```text
Branch:
Commits:

Implemented:
- ...

Files changed:
- ...

Tests:
- ...

Specification/docs changed:
- ...

Database migrations:
- none / ...

Remaining issues:
- none / ...

PR:
- URL if created
```

Be explicit about anything not completed or not verified. Never describe a task as complete when known required work remains.
