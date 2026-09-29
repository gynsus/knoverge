# 38. A connector becomes an agent at the consent screen

Date: 2026-09-29

Status: accepted

## Context

Milestone 10 asks Knoverge to be an OAuth 2.1 authorization server so that
hosted MCP clients — the ChatGPT and Claude.ai connectors — can connect. ADR
0004 already decided that they would, and left the shape of it open: "An OAuth
client is bound, through a consent screen, to an agent identity, so the
permission and audit model does not change."

The gap this closes is narrow and total. Every existing way in carries a
`knv_` bearer token that somebody pasted into a configuration file: Claude Code,
an IDE agent, the stdio bridge, a script. A hosted connector cannot do that. It
is handed a URL by a person who is not its operator, and it has to discover for
itself where to send them to sign in, register itself without anybody having
been told it was coming, and receive a token it can refresh. A product that only
accepts pasted tokens is not reachable from those clients at all, and no amount
of documentation changes it.

What makes this an architectural decision rather than a protocol implementation
is that OAuth brings its own vocabulary — client, grant, scope, token — and
every one of those words already has a meaning here. A client that registers
itself is not an agent. A scope is not a permission grant. An access token is
not a credential. Deciding which of those are the same thing and which are not
is the whole of this ADR; the endpoints follow from it.

The thing to avoid is a second identity model. If an OAuth caller resolved to
something other than an agent, then every permission check, every policy rule,
every ledger event and every screen that lists who may do what would acquire a
second case, and the two would drift. Rule 3 says every material write is
attributable and rule 5 says agents propose by default; neither should have to be
restated for callers who arrived through a different door.

## Decision

**An OAuth grant is an agent credential.** It resolves, through the same
`authenticate` path as a `knv_` token, to the same `ResolvedCredential` — an
agent, in a workspace, with a trust tier. Everything downstream is untouched:
`resolveWorkspaceActor` does not learn a third case, permissions and policy are
evaluated exactly as they are for a pasted token, the rate and concurrency
budgets apply, and the ledger records an agent doing something. A token issued by
the authorization server is a row in the credential table with a different
prefix and an expiry measured in an hour rather than in months.

**Registration grants nothing.** Dynamic client registration is open, because
the hosted connectors depend on it and there is nobody to pre-register them with.
An open unauthenticated write is only safe if what it writes is worthless: a
registered client holds no workspace, no agent, no permission and no token, and
can do nothing except ask a person for consent. It is a name and a redirect URI
until somebody says otherwise.

**Consent is where authority enters, and a person is the only source of it.**
The authorization endpoint requires a browser session. The person must hold
`agent.manage` in the workspace they are connecting — the same permission that
creates an agent by hand, because that is what consent does.

**Consent creates the agent.** Granting produces one agent per (client, person,
workspace), named after the client and the person who let it in, at the default
trust tier: read, search, propose. It then appears on the Agents screen beside
every agent created by hand, where its tier can be raised, its scopes narrowed
and its credentials revoked, by the machinery that is already there. Consenting
again to the same triple reuses that agent rather than making a second one, so
a person who reconnects three times is one actor in the ledger and not three.

Two people who connect the same connector are two agents, which is the point.
`knowledge.created` by "ChatGPT (Grigory)" says who was at the keyboard; one
shared "ChatGPT" actor would not, and rule 3 asks for attribution that means
something.

**The access token is opaque, short-lived and stored hashed.** Not a JWT. A
self-contained token cannot be un-issued, and revocation that takes effect at the
next expiry is not revocation; this product already stores credentials as
peppered hashes with a revocation column and a screen to press, and an access
token is a credential. Since the authorization server and the resource server are
the same process, validating one is a lookup rather than a network call, so
nothing is bought by making it self-describing.

**The refresh token rotates, and replay kills the grant.** Each refresh issues a
new refresh token and retires the one used. A retired refresh token presented
again means the token was captured, so the entire grant — access, refresh and the
agent's other OAuth credentials — is revoked and the person is told. This is the
OAuth 2.1 requirement for public clients, and hosted connectors are public
clients.

**The flow is OAuth 2.1 and nothing beside it.** Authorization code with PKCE,
`S256` only, `plain` refused. No implicit grant, no resource owner password
credentials, no client credentials — a machine with no person behind it does not
need this door, it needs a pasted token. Redirect URIs match exactly as strings,
with no wildcards and no prefix matching; `https` only, except for the literal
loopback hosts, which is what a local client needs and what an attacker cannot
reach.

**Tokens are bound to this server.** A client says which resource it wants with
`resource`; a value that is not this installation's canonical MCP URI is refused,
and the token records the audience it was issued for. One server makes this
almost vacuous, which is the moment to get it right rather than the reason to
skip it.

**Discovery is two documents and a challenge.** The protected-resource
document says which authorization server stands in front of `/mcp`, the
authorization-server document says where its endpoints are, and
`/mcp` answers an unauthenticated call with `401` and a `WWW-Authenticate` header
naming the first. That is the sequence a connector walks when a person gives it
nothing but a URL, and it is the entire reason any of this is reachable.

**No new event types.** Consent creates an agent and issues a credential, and
`agent.created` and `agent.credential_issued` are what those are called here;
revocation is `agent.credential_revoked`. The client id goes in the metadata.
Issuing an access token from a refresh token is an authentication, and rule 4
says authentications are not ledger events — there would be one every hour per
connector, and they would say nothing that the grant does not already say.

**A client identifier is a registration, not a URL to go and read.** There is a
newer way for a client to say who it is — Client ID Metadata Documents, where the
`client_id` is an `https` URL and the authorization server fetches the metadata
from it. ChatGPT prefers it and keeps dynamic registration "supported when
configured", so registration is enough to be reachable, and the difference is
one this product cannot be neutral about: honouring a metadata document means
making an outbound request to a URL an unauthenticated caller chose. Rule 12
says the server contacts nothing the operator did not configure, and an
attacker-chosen fetch is also the plainest server-side request forgery there is —
this process can reach the database and whatever else the network puts near it.
Not supported. If a connector one day requires it, it arrives as an operator
switch with an allowlist and its own ADR, not as a default.

**A client nobody consented to expires.** Registration is unauthenticated, so
registrations accumulate. One that has never completed an authorization is
deleted after a short while by the job runner, and the endpoint is rate limited
like any other unauthenticated write. A client that holds a grant is kept as long
as the grant is.

## Consequences

**A connector that registers itself again is the connector it was.** This is the
price of declining Client ID Metadata Documents, and it was found by connecting
a real one: disconnecting in Claude.ai does not call the revocation endpoint,
and reconnecting registers a second client. By client id those are two
connectors, so without something else they become two agents, and the first
connection stays live with a working refresh token that the person believes
they ended.

What identifies a returning connector, in the absence of a stable client id, is
the name it calls itself together with the addresses it will accept a code at.
Two genuinely different products would have to share both, and sharing a
callback address means sharing the service behind it. So consent matches on
exactly those two, retires the connection it finds, and keeps the agent: the
new grant points at the agent the old one did, and the history reads as one
connector rather than as a queue of them. The consent screen says which
connection is being replaced before anything is.

An exact match on both, or nothing. A near match is a guess, and the thing being
guessed at is which agent somebody's knowledge is attributed to.

ChatGPT and Claude.ai reach a self-hosted Knoverge with no operator step beyond
the one that already exists — a person signs in and presses a button — and the
result is an agent that proposes rather than writes, because rule 5 is not
restated for them either.

The consent screen is the security boundary, and it has to look like one. A
client's own `client_name` is attacker-supplied text; it is displayed as such,
and beside it the screen shows the host of the redirect URI, which is where the
token actually goes and the only part of the request the attacker cannot
misrepresent.

Knoverge gains an authorization server's attack surface: six endpoints, three of
which are reachable without authentication. That is real, and it is the price
ADR 0004 already accepted. It buys nothing except reachability, and the design
above spends it as narrowly as it can — the endpoints issue credentials into a
model that already existed rather than building a second one.

Deployment grows a requirement that was previously advice: the authorization
server's issuer is `KNOVERGE_BASE_URL`, redirect URIs are `https`, and a
connector will not talk to `http://localhost`. An installation that wants hosted
connectors needs a public HTTPS address, and the deployment guide has to say so
where somebody will read it before they try.

Nothing changes for the callers that exist. A pasted `knv_` token is still the
way Claude Code, the stdio bridge and every script connect, and it is still the
simpler way when there is somewhere to paste it.

## Rejected alternatives

### JWT access tokens

Standard, self-contained, and validated without touching the database. Rejected
because revocation is the property that matters more: an agent's access has to
stop when somebody presses revoke, not when the token expires. A short expiry
narrows the window rather than closing it, and the lookup a hashed token costs is
one indexed read on a request that is about to do several.

### Binding a client to an agent that already exists

Consent would pick an agent from a list instead of creating one. Rejected because
it hands a hosted connector the credentials of an identity that was created for
another channel, and because the list is a worse question to ask a person than
the one this design asks: the choice is which workspace, not which of these
records is the right one to impersonate.

### An operator registers each client by hand

Closes the unauthenticated registration endpoint, which is genuinely the largest
piece of new surface. Rejected because the hosted connectors do not offer it — a
person adding a connector in ChatGPT has no way to send an operator a client id
first — so it would close the endpoint and the milestone with it.

### Client ID Metadata Documents

The direction the ecosystem is moving, and it removes the unauthenticated
registration endpoint entirely, which is the surface this design likes least.
Rejected for now on rule 12: the server would fetch a URL chosen by whoever sent
the request. That can be made safe — an operator allowlist, a resolved-address
check, no redirects, a size and time bound — but every one of those is a decision
somebody has to be able to read later, and none of them is needed while dynamic
registration still works.

### Being an OAuth client of an external identity provider instead

Sign-in through Google or an enterprise IdP is a different feature that is also
wanted, and it does not help here: it authenticates people, and what a connector
needs is a token for itself. It stays where the plan has it, under later work
alongside TOTP and OIDC sign-in.
