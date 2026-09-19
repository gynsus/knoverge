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
docker compose up -d postgres
pnpm dev            # server on http://localhost:3000
```

Turborepo sends anonymous telemetry by default; disable it once with `pnpm turbo telemetry disable`. CI and the Docker build already run with it disabled.

Checks:

```bash
pnpm lint           # eslint + prettier
pnpm typecheck
pnpm test
pnpm build
pnpm check          # all of the above except build
```

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

Do not open a public issue for a vulnerability. Use the contact described in `SECURITY.md` at the repository root (to be added before public release).

## Pre-release checklist

Before the repository is made public:

- `LICENSE` (Apache 2.0) present;
- `CODE_OF_CONDUCT.md` present;
- root `SECURITY.md` with a vulnerability-reporting contact;
- issue and pull request templates;
- CI running lint, typecheck, and tests;
- English and Russian message catalogues complete for the shipped UI.
