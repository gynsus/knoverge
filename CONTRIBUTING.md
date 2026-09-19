# Contributing

## Project values

Contributions should preserve:

- self-hosted operation;
- provider neutrality;
- human control;
- portable canonical data;
- provenance;
- auditability;
- no telemetry;
- backwards-compatible public contracts where practical.

## Language

Everything in the repository is written in English: code, comments, commit messages, documentation, ADRs, issues, and pull requests.

User-facing interface text is translatable through message catalogues. See `docs/I18N.md` for how to add or update a translation.

## Workflow

Branching, commits, pull requests and verification rules are defined in [docs/WORKFLOW.md](docs/WORKFLOW.md). `main` is protected; all changes arrive through pull requests.

## Development

Prerequisites: Node.js from `.nvmrc` (use `nvm use`), corepack (`corepack enable`), Docker.

```bash
nvm use
corepack enable
pnpm install
cp .env.example .env
# Fill in the four empty values rather than appending duplicates of them.
for key in KNOVERGE_LEDGER_KEY KNOVERGE_SESSION_SECRET KNOVERGE_TOKEN_PEPPER KNOVERGE_POSTGRES_PASSWORD; do
  sed -i.bak "s|^$key=.*|$key=$(openssl rand -hex 32)|" .env
done && rm -f .env.bak
docker compose up -d postgres
pnpm dev            # API on :3000, web interface on http://localhost:5173
```

Turborepo sends anonymous telemetry by default; disable it once with `pnpm turbo telemetry disable`. CI and the Docker build already run with it disabled.

Checks:

```bash
pnpm lint           # eslint + prettier + locale catalogue parity
pnpm typecheck
pnpm test           # integration tests start PostgreSQL through Testcontainers; Docker must be running
pnpm build
pnpm check          # all of the above except build
```

Database migrations live in `packages/db/migrations` and are applied by the server on start (`KNOVERGE_AUTO_MIGRATE`) or by `knoverge db migrate`.

```bash
pnpm --filter @knoverge/db migrations:generate          # diff the Drizzle schema into a new migration
pnpm --filter @knoverge/db migrations:custom --name x   # empty migration for hand-written SQL
```

Review the generated SQL before committing. See `docs/WORKFLOW.md` section 9 for the migration policy.

Full stack in Docker:

```bash
docker compose up --build
curl http://localhost:3000/health/ready
```

## Architecture changes

Create an ADR under:

```text
docs/adr/
```

when changing:

- authoritative storage;
- core runtime dependencies;
- public MCP/HTTP semantics;
- identity/security model;
- consistency model;
- deployment architecture.

Small implementation choices do not require an ADR.

## Pull requests

A PR that changes behaviour should include:

- tests;
- documentation;
- migration if required;
- message catalogue updates if UI text changed;
- compatibility note for public MCP/API changes.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) 1.1.

Sign off each commit and follow Conventional Commits:

```bash
git commit -s -m "feat(server): add workspace bootstrap flow"
```

No separate contributor licence agreement is required.

## Knowledge and AI-generated contributions

AI-assisted code is welcome.

The human contributor remains responsible for:

- correctness;
- licensing;
- tests;
- security;
- understanding the submitted change.

Do not commit copied proprietary code or model outputs with unclear licensing provenance.

## Reporting security issues

Do not open a public issue for a vulnerability. Until the repository is public and a root `SECURITY.md` names a contact, report it privately through GitHub's "Report a vulnerability" on the Security tab, or to the repository owner directly.

`docs/SECURITY.md` is the threat model and design document, not a reporting address.

## Pre-release checklist

Before the repository is made public:

- `LICENSE` (Apache 2.0) present;
- `CODE_OF_CONDUCT.md` present;
- root `SECURITY.md` with a vulnerability-reporting contact;
- issue and pull request templates;
- CI running lint, typecheck, and tests;
- English and Russian message catalogues complete for the shipped UI.
