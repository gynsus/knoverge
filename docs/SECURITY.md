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

- login rate limiting per IP, plus a per-account lockout that covers the per-address dimension;
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
- lockout after 10 failed passwords for 15 minutes, plus per-IP limits on login and bootstrap; a locked account answers exactly like a wrong password, so the lockout is not an oracle for which addresses are registered;
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
- rotation: issue a new credential, revoke the old one, both audited;
- disabling an agent revokes every credential it holds in the same transaction;
- authentication failures are indistinguishable to the caller, whether the token is unknown, revoked, expired or belongs to a disabled agent;
- successful authentication updates `last_used_at` and `last_seen_at` and is logged, but is not a ledger event (ADR 0007).

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

A trust tier is not stored as grants: it is the baseline a request is evaluated against. Three rules decide the outcome:

- an explicit `deny` beats everything, including a role or tier, so a narrow deny carves an exception out of a broad allow;
- for an **agent**, an explicit `allow` for an action replaces the trust tier baseline for that action, which is how an agent is restricted to one branch. Without this a tier that already allows the action everywhere would make a scoped grant meaningless;
- for a **person**, a role is the statement of their authority and is never replaced by someone else's grant. A scoped allow for an action the role already carries is refused, because storing it would silently narrow them; restricting a person is what a deny grant is for;
- otherwise the baseline decides.

A listing endpoint asks whether the actor holds the action anywhere, then filters its results to the scopes that cover them, so a branch-scoped reader sees its branch instead of being refused outright.

The same applies to humans: a workspace role carries a baseline set of permissions (`viewer` reads, `reviewer` also writes and approves, `admin` also manages agents, taxonomy and policy, `owner` also administers the workspace).

## 8. Scoped access

Permissions and policy rules carry a scope selector stored by **stable category ids** with `include_descendants`, plus optional type and language filters. Paths are accepted by the API and UI for convenience and resolved to ids at write time.

Renaming, moving or merging a category therefore never changes who can access its items, and a new category created later under an old path never inherits an old grant.

Selectors apply to reads as well. The taxonomy listing is filtered to readable branches today; search, index, briefing, changes and events are filtered the same way as they arrive.

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

### Granting permissions

`policy.manage` allows an actor to administer grants, not to acquire privileges:

- an allow grant is refused unless the granter already holds that action, so nobody hands out more than they hold;
- `workspace.admin`, `policy.manage` and `agent.manage` are never granted to an agent actor, because an agent is automation acting for a person and must not become a route around the membership model;
- a deny grant needs no matching privilege, so access can always be narrowed;
- the subject actor must belong to the granter's workspace.

Revoking a grant changes authority as much as adding one, because removing a deny restores what it restricted. The same rules therefore apply in both directions:

- a grant is revoked only by someone who holds the action it names;
- a deny placed on you is never yours to lift, however narrow its scope, so somebody else has to remove it.

Without these rules an administrator could create an agent, grant it `workspace.admin`, and use its token to take ownership of the workspace; or simply delete the deny that restricted them.

### Roles and trust tiers are permission sets

A membership role and an agent's trust tier each stand for a set of actions, so choosing one hands out every action in it. The rule above applies unchanged:

- a member is added or moved to a role only by someone who holds every action that role carries, so an administrator cannot create a member more powerful than themselves;
- an agent is created at, or raised to, a trust tier only by someone who holds every action in it, so `agent.manage` cannot be used to build a token that does more than its author can;
- nobody changes their own role or removes their own membership, because that would turn a grant somebody can take back into a role they cannot;
- a policy rule with the `allow_direct` effect decides in advance what a reviewer would decide case by case, so writing one requires `knowledge.approve`.

`workspace.admin` alone used to be enough to promote oneself to owner, which made it equal to ownership rather than a part of it.

### Scopes apply where the object is

A permission is checked against the object the request names, not against the request alone. Every taxonomy mutation is checked against the category it changes, and a move against both the category and its destination, so a branch-scoped grant covers exactly that branch. A check with no object would silently ignore every scoped grant: a deny would not restrict, and an allow would refuse everything.

Creating a root category belongs to no branch, which no category-scoped grant covers.

### Command line access

`knoverge` commands run on the host with the database credentials and act as the workspace's system actor. They are not subject to permission grants: an operator with shell access on the server already controls the installation. Their changes are recorded in the ledger like any other.

## 9a. Cross-site request forgery

CSRF protection applies to cookie-authenticated browser requests. A request authenticated with a bearer token carries no ambient authority and is not forgeable this way, so agents are not asked for a token they cannot obtain.

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

Every route has a per-actor budget, keyed on the agent or the signed-in user and falling back to the address for anonymous callers. Several agents behind one reverse proxy therefore get separate budgets, and one noisy caller cannot spend everyone else's.

Stricter per-route limits apply to authentication failures, and to proposal writes and sync batches when they arrive.

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
