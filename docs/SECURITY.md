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

The server may face the Internet from Milestone 4 on, which has shipped, so the baseline is in place.

Milestone 1 (web and accounts):

- login rate limiting per IP, plus a per-account lockout that covers the per-address dimension;
- `HttpOnly`, `Secure`, `SameSite=Lax` session cookies;
- CSRF token on state-changing browser requests;
- request body size limits;
- security headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Frame-Options`, HSTS when behind TLS.

Milestone 4 (agents), shipped:

- per-credential rate limits, one budget for reads and a tighter one for writes; the sync batch bucket arrives with the sync operations in Milestone 5;
- MCP request size limit (512 KiB, under the megabyte accepted elsewhere);
- at most eight requests in flight per credential, which a per-minute budget cannot express.

Milestone 9 (operations): audit export, backup tooling, webhooks, token rotation UI, advanced hardening.

Milestone 9 hardening has not shipped, so an Internet-facing deployment should sit behind a reverse proxy that terminates TLS and adds its own rate limiting.

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
allow knowledge.read_history
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

### An archived workspace

While `workspaces.archived_at` is set, every action that would change the knowledge is dropped before any grant is read: the four `knowledge.propose_*` actions, `knowledge.write`, `knowledge.approve`, `taxonomy.propose` and `taxonomy.manage`. It outranks a role, a trust tier and an explicit allow, so no credential and no `allow_direct` rule can write there. The refusal is recorded as `command.denied` with the reason `workspace_archived`, which is deliberately distinguishable from a missing grant.

Reading is untouched, and administration is not frozen: `workspace.admin` is how the workspace is brought back, and `agent.manage` is how a credential is revoked. The system actor — the operator on the host — is unconstrained, as everywhere else. ADR 0018 has the reasoning.

Every way in asks: the single check, the listing check, the report of what somebody holds, and the filter that narrows a list to what they may act on. The one exception is the question "does this person have the authority to hand out this role", which is about standing rather than about whether the workspace is accepting changes — freezing it would stop an administrator adding a member to an archived workspace, because the roles they can assign include writing.

## 8. Scoped access

Permissions and policy rules carry a scope selector stored by **stable category ids** with `include_descendants`, plus optional type and language filters. Paths are accepted by the API and UI for convenience and resolved to ids at write time.

Renaming, moving or merging a category therefore never changes who can access its items, and a new category created later under an old path never inherits an old grant.

Selectors apply to reads as well. The taxonomy listing is filtered to readable branches today; search, index, briefing, changes and events are filtered the same way as they arrive.

## 8a. A refusal must not describe what it refused

Anything a caller is told about knowledge it may not read is a leak, including
a refusal. The duplicate check found candidates by content hash and by title
similarity and answered with their ids, titles and file paths, without asking
whether the proposer could read them; trigram similarity fires at 0.6, so a
proposer could map a closed branch by guessing titles and reading the answers.

A match outside the proposer's scope is now not raised at all. It sends the
write to review instead, so the workspace is still protected from a duplicate
and the proposer learns only that its write was queued — which policy does for
its own reasons. ADR 0017 has the reasoning, including why telling the proposer
even that something exists was rejected.

The same rule governs reconciliation: `sync_submit_inventory` classifies a
candidate as though nothing matched when the only match is one the agent cannot
read.

## 9. Approval policy

The policy engine decides, for an action the actor is permitted to attempt:

```text
deny
allow_direct
require_review
```

Rules are stored in PostgreSQL (`PolicyRule`) and edited in the web interface, on the policy page:

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

The same refusal by the same actor is recorded once a minute rather than once a request. The ledger is append-only and nothing prunes it, so a caller looping on an endpoint it may not use would otherwise write without limit and hold the workspace's ledger lock ahead of every real write. The first refusal is the fact worth keeping; the repetitions are that same fact again.

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

A permission is checked against every object the request changes, not against the request alone. A taxonomy mutation that rewrites a subtree, meaning an archive, a move, or a rename that changes the slug, is checked against the whole subtree; a move is checked against its destination as well; a new category against its parent. A check with no object would silently ignore every scoped grant: a deny would not restrict, and an allow would refuse everything.

Creating a root category belongs to no branch, which no category-scoped grant covers.

An allow and a deny read a scope differently, and they have to:

- an **allow** must cover every category the request touches. An object filed in a permitted and a restricted branch is not reachable through the permitted one.
- a **deny** fires as soon as it covers one of them. A restriction that only applied when it covered all of them was bypassed by renaming or archiving the parent, because the parent is not inside the restricted branch and the whole operation was judged to fall outside it.

A scope may be written with `category_path` instead of `category_id`. The path is resolved to an id when the grant is stored, so what is compared is always the id: a rename or a move cannot detach a grant from the branch it covers. A path is portable, never a security identifier.

### Authority has to cover what it hands out

Granting is checked against the scope of the grant, not against the action alone:

- a branch-scoped grant requires the granter to hold the action for each branch it names;
- an unscoped grant requires the granter to hold the action and to be under no restriction on it anywhere. Anything less let a restricted administrator hand the action out unrestricted, to an agent they created, and then act through that agent's token. The restriction was not lifted, it was walked around.

Minting a credential is checked the same way as choosing the tier, because the token is what actually hands the tier's permissions to whoever holds it.

A restriction aimed at yourself is refused. Revoking it would need the action it took away, and a deny on you is not yours to lift, so there would be no way back. `knoverge permissions` is the operator's route in: it runs as the workspace system actor and is recorded in the ledger like any other change.

### Who chooses the provenance on an event

A person's `session_id` is the identifier of their real session, never a header: a caller must not be able to choose how its own actions are attributed.

An agent has no such session, so it may name its client's conversation with `X-Knoverge-Session-Id`. That value is recorded with an `ext:` prefix, because the agent chose it. Without the prefix an agent could stamp its events with a person's session identifier, and anything correlating the audit trail by session would read the agent's actions as that person's. The actor and agent identifiers on the event are resolved from the credential and stay truthful either way.

`X-Request-Id` is likewise the caller's own, so two callers can deliberately share one. It groups a call with its retries; it does not identify anybody.

### Checking and acting are one step

A rule that decides whether a write may happen is read inside the transaction that performs it, holding the lock that protects it. Reading first and writing afterwards lets two requests each decide on a state the other is about to change:

- two taxonomy mutations each validated against a tree the other was rewriting, so a move could reparent a category whose path a rename had already changed, leaving the parent and the path disagreeing, and two moves could make each other's parent and produce a cycle. A category whose path no longer resolves gets no ancestors, so every category-scoped grant with `include_descendants` silently stops covering it: a corrupt path weakens authorisation, not only presentation.
- two removals each counted two owners and each removed one, leaving a workspace with no owner and no way back through the API.
- parallel wrong passwords each read the same failure count and wrote it back, so the account never reached the lockout threshold. The count is now added by the database and the lockout decided from what it returns.

### Password rules

A password is 12 to 200 characters and may not contain the account's email address, nor the part before the `@` when that is four characters or more. The same rules apply when a password is changed.

Hashing is argon2id at the OWASP 2024 minimum parameters, with a per-password salt. A change revokes every other session of that account.

### Command line access

`knoverge` commands run on the host with the database credentials and act as the workspace's system actor. They are not subject to permission grants: an operator with shell access on the server already controls the installation. Their changes are recorded in the ledger like any other.

## 9a. Cross-site request forgery

CSRF protection applies to cookie-authenticated browser requests. A request that carries an `Authorization: Bearer` header is exempt: a browser never attaches that header on its own, so such a request is not forgeable this way, and an agent is not asked for a token it cannot obtain.

The exemption is decided by the header being present, not by the credential resolving. Deciding it on the resolved agent meant an expired or revoked token was refused by the CSRF hook before the route could answer, so the agent was told `FORBIDDEN` and not to retry, when the correct instruction was to get a new token.

The secret cookie is signed and cleared on sign-out, so the next person on that browser starts with their own.

Known limitation: the token is not bound to the session, so it is a double-submit pair. An attacker who can write a cookie for this host, from a sibling subdomain or over plain HTTP, could plant a matching pair. Binding the token to the user would require every client to fetch a new token after signing in, and the deployment guidance is TLS with no untrusted sibling subdomain, so the pair stands for now. It is recorded here rather than left unsaid.

## 9b. Regaining access

No installation has a mail server, so there is no reset link and no one-time
code (ADR 0004, and ADR 0014 for what replaces them).

An administrator may set a member's password, bounded by the rule every
membership action follows: you may act on somebody only if you hold every
permission their role includes. An admin therefore cannot reset an owner's
password. The reset writes a `user.password_reset` event naming who did it and
to whom, and revokes every session that member holds, so an account that was
taken over does not stay taken over and a person who did not ask for it finds
out at once.

Changing your own sign-in address needs the current password. A stolen session
is therefore not enough to move an account somewhere its owner cannot follow.
The new address is not verified — there is nothing to verify it with — so a
mistyped address is recovered through an administrator or the command line.

The command line can reset a password or an address for anyone, including the
last owner of a workspace, who by construction has nobody above them. This
grants nothing new: whoever can run it can already read `KNOVERGE_LEDGER_KEY`
and write to the database. It exists so that they do not have to, and so the
change goes through the domain rules rather than past them.

No route, event or log line records an email address.

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

The limiter gives each route its budget as the route is declared, so it is registered before any route exists and after the authentication hooks, which is what lets it key on the resolved caller rather than the address. Paths that match no route reach the not-found handler, which asks for a budget of its own: the single-page fallback reads a file from disk on every hit.

Readiness has a separate, tighter budget. It is unauthenticated and runs every probe, including the database, so it is the one endpoint where repeated calls cost more than the reply.

The limiter runs after authentication, so a request that ends in a refusal has already paid one indexed lookup. Tokens are compared by digest rather than by a key derivation function, so that lookup is a query, not work an attacker can amplify.

Stricter per-route limits apply to authentication failures, and to proposal writes and sync batches when they arrive.

## 13a. The workspace repository

Canonical knowledge is a Git repository per workspace, written by running `git` (ADR 0002). That makes the boundary between the server and the operator's own machine a security boundary, and it is drawn as follows.

**The repository is named, never discovered.** Every invocation passes `--git-dir` and `--work-tree` explicitly. Git's own search walks up the directory tree, so a data directory that happens to sit inside another working tree — the documented development default puts `./data` inside the Knoverge checkout — would otherwise let a missing `.git` silently redirect canonical commits into the operator's repository, and `git add` would sweep whatever that tree held.

**Only the operation's own paths are staged.** One domain operation is one commit, whatever else is in the directory. Staging everything would fold an editor's swap file or a desktop's `.DS_Store` into an unrelated commit and would turn a change that alters nothing into a commit carrying only that junk.

**The environment is built from an allowlist, not inherited.** `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*`, `GIT_EXTERNAL_DIFF` and their relatives never reach git, because none of them is anything Knoverge sets on purpose and each of them redirects or subverts a write.

**No configuration the server did not choose applies.** System and global configuration are switched off and `core.hooksPath` is forced empty, so the server never executes a hook, a template or an fsmonitor an operator installed for their own work. A repository configured with husky would otherwise run its `pre-commit` script as the server user on every canonical write.

**Nothing caller-supplied reaches the command line as an option or a path.** Arguments are always passed as an array, never through a shell. Commit hashes are checked against their shape before they become arguments, paths are resolved inside the repository and refused if they reach `.git`, and a commit subject or trailer value containing a line break is refused — a forged trailer would otherwise let a title speak for the commit when recovery reads it.

**Attribution cannot be dressed up as somebody else.** The author address is always `<actor id>@knoverge.local`, and a display name is stripped of the characters git would render as an address before it is used.

**The backup container is not privileged.** It drops to the database image's own unprivileged user before doing any work, mounts the data directory read-only, and only writes to the backup volume. It copies canonical knowledge and archives it; neither task needs the privileges of the machine.

**A workspace cannot fill the disk every workspace shares.** Every taxonomy change rewrites the whole file and commits it, so without a ceiling a holder of `taxonomy.manage` in one workspace could grow its repository with the square of the number of changes until the volume was full — taking PostgreSQL down with it wherever an operator put both on one filesystem. A workspace holds at most 2 000 categories, the rendered `taxonomy.yaml` is capped at 1 MiB, and `git gc --auto` runs after each commit while the write lock is still held.

Not yet enforced, and known: a commit an operator adds on top of HEAD is not detected. It is recorded in `docs/GIT_REPOSITORY.md` §9.

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
