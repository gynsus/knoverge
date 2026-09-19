# ADR 0006: Implementation stack choices

- Status: Accepted
- Date: 2026-09-19

## Context

The specification named Node.js, TypeScript, Fastify, Zod, PostgreSQL, pgvector, the MCP SDK and pnpm/Turborepo but left several runtime dependencies open: database access layer, Git implementation, job queue, web build tooling, i18n library, test tooling. These are core runtime dependencies and therefore need a recorded decision.

The project also wants to stay on current, proven versions and remain upgradeable.

## Decision

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js, current Active LTS line, pinned in `.nvmrc` and `engines` | Long support window; upgrade one LTS at a time |
| Language | TypeScript strict | Contract safety across packages |
| HTTP | Fastify | Fast, schema-friendly, plugin model fits adapters |
| Validation | Zod (current major) | Single runtime schema source for contracts and OpenAPI |
| Database access | Drizzle ORM with SQL migrations | Schema as TypeScript, generated SQL migrations reviewed in PRs, no runtime magic, raw SQL where needed (FTS, pgvector) |
| Jobs | pg-boss | PostgreSQL-only queue with retries, scheduling and archiving; no Redis |
| Git | Git CLI via child process behind a `GitStore` interface | Battle-tested behaviour for commits, renames, diffs and history; `git` is a small addition to the image; the interface allows swapping to a library later |
| Web | React with Vite, react-router, TanStack Query | Lightweight SPA build, fast iteration |
| i18n | i18next with react-i18next, ICU messages | Mature Russian plural support, wide tooling |
| Tests | Vitest, Testcontainers (PostgreSQL), Playwright for UI | Real database in integration tests without mocks |
| Monorepo | pnpm workspaces, Turborepo | Cached pipelines across apps and packages |
| Packaging | Docker multi-stage image, Docker Compose | Single image for self-hosting |

Version policy:

- exact versions are chosen and pinned in Milestone 0 after checking current releases;
- automated dependency updates (Renovate or Dependabot) keep them current;
- major upgrades of framework-level dependencies get a changelog entry and, when behaviour changes, an ADR amendment.

## Consequences

### Positive

- No dependency outside Node.js, PostgreSQL and Git at runtime.
- Every layer has an interface that allows replacement without touching domain code.

### Negative

- The Git CLI must be present in the image and on developer machines.
- Drizzle migrations must be reviewed carefully for pgvector and FTS columns that it does not model natively.

## Rejected alternatives

### isomorphic-git

Pure JavaScript, but slower on large repositories and less complete for rename detection and diff. Kept as a possible fallback behind the same interface.

### Prisma

Rich tooling, but a heavier runtime and awkward support for pgvector and FTS. Rejected.

### Hand-rolled job table

Possible, but pg-boss already provides retries, scheduling and archival on PostgreSQL. Rejected.
