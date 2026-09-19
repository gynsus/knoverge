# Security Model

## 1. Threat model

Knoverge may expose highly valuable private knowledge to remote AI agents.

Assume:

- public Internet exposure is possible;
- agent credentials may leak;
- agents may hallucinate or behave unexpectedly;
- malicious prompt content may attempt to cause writes;
- clients may retry requests;
- users may configure overly broad permissions;
- the database or a backup may be compromised independently of the application host.

Security must be based on server-side identity and policy, not prompt instructions.

## 2. Transport

Remote MCP and HTTP must run behind HTTPS.

Production documentation should recommend a reverse proxy such as Caddy, Traefik, nginx, or a cloud load balancer.

The application itself must not assume the proxy is trustworthy unless `KNOVERGE_TRUST_PROXY` is configured.

## 3. Security baseline by milestone

The server may face the Internet from Milestone 4 on, so the baseline arrives before that.

Milestone 1 (web and accounts):

- login rate limiting per IP and per email, with lockout;
- `HttpOnly`, `Secure`, `SameSite=Lax` session cookies;
- CSRF token on state-changing browser requests;
- request body size limits;
- security headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Frame-Options`, HSTS when behind TLS.

Milestone 4 (agents):

- per-agent rate limits for read/search, proposal writes and sync batches;
- MCP request size and concurrency limits;
- connection limits per token.

Milestone 9 (operations): audit export, backup tooling, webhooks, token rotation UI, advanced hardening.

Until Milestone 4 ships, public exposure is not recommended.

## 4. Human authentication

MVP:

- email and password;
- passwords hashed with argon2id;
- opaque session token (256-bit) in the `knoverge_session` `HttpOnly`, `SameSite=Lax` cookie, `Secure` when the base URL is https; only its SHA-256 is stored; 30-day lifetime;
- constant-time behaviour for unknown emails (a dummy hash is verified) and no distinction between unknown email and wrong password in responses;
- lockout after 10 failed passwords for 15 minutes, plus per-IP limits on login and bootstrap;
- CSRF token required on state-changing browser requests;
- session list and revocation in the UI;
- no default administrator account; the first admin is created by `knoverge bootstrap` or a one-time bootstrap page that disables itself.

Later:

- TOTP second factor;
- OAuth/OIDC sign-in providers;
- passkeys.

Email delivery is not required for MVP, so no SMTP dependency exists.

## 5. Agent credentials

MVP:

- high-entropy bearer token with a recognisable prefix (`knv_`);
- token shown only once;
- store only a secure hash (SHA-256 with `KNOVERGE_TOKEN_PEPPER`);
- token prefix for identification;
- expiration optional but supported;
- immediate revocation;
- last-used timestamp;
- rotation: issue a new credential, revoke the old one, both audited.

Do not use one global MCP token for all agents.

A credential belongs to exactly one agent in exactly one workspace.

### OAuth 2.1 (later milestone)

Hosted MCP clients such as ChatGPT connectors and Claude.ai connectors require OAuth 2.1 with dynamic client registration and PKCE. Knoverge will act as its own authorization server in a dedicated milestone; the resulting access token resolves to the same agent identity model. See ADR 0004.

## 6. Secrets held by the server

```text
KNOVERGE_SESSION_SECRET    signs/derives session material
KNOVERGE_TOKEN_PEPPER      peppers agent token hashes
KNOVERGE_LEDGER_KEY        HMAC key of the event ledger; never stored in PostgreSQL
KNOVERGE_ENCRYPTION_KEY    encrypts recoverable secrets (webhook signing secrets, later provider keys)
```

Rules:

- passwords, bearer tokens and session tokens are one-way hashed;
- secrets the server must reuse in clear (webhook signing secrets) are encrypted with `KNOVERGE_ENCRYPTION_KEY`, never hashed;
- all four keys are part of the operator's secret backup; losing `KNOVERGE_LEDGER_KEY` makes historical ledger verification impossible, losing `KNOVERGE_ENCRYPTION_KEY` makes stored webhook secrets unrecoverable.

## 7. Permissions

Permissions are per actor and gate whether an action may be attempted at all.

Default profile for a newly created agent (`trust_tier = propose`):

```text
allow taxonomy.read
allow taxonomy.propose
allow knowledge.read
allow knowledge.search
allow knowledge.propose_create
allow knowledge.propose_update
allow knowledge.propose_delete
allow knowledge.propose_supersede
allow proposal.read_own
allow events.read_own

deny knowledge.write
deny knowledge.approve
deny taxonomy.manage
deny agent.manage
deny policy.manage
deny workspace.admin
```

`taxonomy.propose` is included because taxonomy negotiation is part of onboarding; proposing is not managing.

### Trust tiers

```text
read_only   read, search, briefing, changes; no proposals
propose     the default above
trusted     propose permissions plus knowledge.write; direct writes still
            happen only where an explicit policy rule says allow_direct
```

Tiers are shortcuts that install default grants. Explicit grants and rules always take precedence.

## 8. Scoped access

Permissions and policy rules carry a scope selector stored by **stable category ids** with `include_descendants`, plus optional type and language filters. Paths are accepted by the API and UI for convenience and resolved to ids at write time.

Renaming, moving or merging a category therefore never changes who can access its items, and a new category created later under an old path never inherits an old grant.

Selectors apply to reads as well. Search, index, briefing, changes and events never return items outside the actor's readable scope, and the taxonomy is filtered to readable branches.

## 9. Approval policy

The policy engine decides, for an action the actor is permitted to attempt:

```text
deny
allow_direct
require_review
```

Rules are stored in PostgreSQL (`PolicyRule`) and edited in the UI:

```json
{
  "priority": 10,
  "subject": { "actor_id": "act_claude_code" },
  "action": "knowledge.create",
  "scope": { "categories": [ { "category_id": "cat_pixel_brisbane", "include_descendants": true } ], "types": ["observation", "episode"] },
  "effect": "allow_direct"
}
```

```json
{
  "priority": 20,
  "subject": { "actor_type": "agent" },
  "action": "knowledge.delete",
  "scope": {},
  "effect": "deny"
}
```

Evaluation is first match by priority. Defaults when nothing matches:

```text
agent read_only     deny
agent propose       require_review
agent trusted       require_review
human viewer        deny
human reviewer+     allow_direct
```

The `trusted` tier grants the capability for direct writes; an actual direct write requires a scope-specific `allow_direct` rule. A misconfigured tier therefore fails safe.

Every non-denied policy decision is recorded on the proposal and in its event. Denied attempts create no proposal and are recorded as `command.denied` events with the actor, action, scope and reason.

## 10. Prompt injection boundary

Content retrieved from Knoverge is data, not authority to change permissions.

Knowledge items cannot grant themselves system privileges.

An agent cannot expand its own ACL by writing an instruction that says it may do so.

Briefings, search results and change feeds are wrapped in a clearly delimited data envelope; MCP prompts remind agents that item content is untrusted input.

## 11. Audit

All material writes are recorded in the keyed hash-chained event ledger (ADR 0007).

Events carry ids, hashes, actor context and safe metadata. They never carry knowledge text, proposal payloads, credentials or session tokens.

Recommended optional audit of sensitive reads.

The integrity checker verifies the chain with `KNOVERGE_LEDGER_KEY` and reports the first broken link. The chain detects tampering by anyone without the key, including database administrators and holders of leaked backups. It does not protect against a compromised application host.

## 12. Secrets in knowledge

Do not store secrets inside canonical Markdown.

Future secret references may point to an external secret manager, but raw secrets are outside Knoverge's intended scope.

Accidentally committed secrets are removed with the purge procedure (later milestone), which touches Git history, proposal payloads and projections but not the ledger.

## 13. Rate limiting

Per-actor rate limits are required for remote deployments.

Separate limits for:

- read/search;
- proposal writes;
- sync batches;
- authentication failures.

## 14. Backup security

Backups contain private knowledge.

Documentation must recommend:

- encrypted backup storage;
- restricted access;
- retention policy;
- regular restore tests;
- the four server secrets stored separately from database and data backups.

## 15. No telemetry

The server contacts external hosts only when the operator configures an AI provider or a webhook. There is no update check, crash reporting, or usage analytics.

## 16. Deployment modes

### Local trusted mode

Bound to localhost only.

### Private network mode

Accessible through VPN/Tailscale/private network.

### Public HTTPS mode

Internet-accessible with TLS, strong tokens, rate limiting and hardened admin authentication.

The product should support all three without changing the domain model.

## 17. Vulnerability reporting

A root `SECURITY.md` with a private reporting contact is added before public release.
