# 29. A webhook carries a notification, not the knowledge

Date: 2026-09-27

Status: accepted

## Context

Milestone 9 asks for webhooks. The obvious shape is the one most products ship: on
a change, post the changed thing to a URL the operator configured.

Two rules in this product point the other way.

Rule 4 says the ledger holds ids, hashes, actor context and safe metadata, never
knowledge text, proposal payloads or secrets. Every feed derived from it inherits
that: `events_list` names objects, `knowledge_changes` names revisions, and a
caller fetches what it may read afterwards with its own credential.

And a webhook has no credential at all. A URL is not an actor: it holds no
permission grant, no read scope, no category restriction. Rule 13 scopes reads by
category id, and there is no category scope to apply to an endpoint nobody
authenticated. Posting content to it would hand an unauthenticated address what no
credential in the workspace is guaranteed to be allowed to read.

## Decision

A webhook delivers the event, not the object. The body is a batch of the same
event summaries `events_list` serves — type, object type and id, actor, sequence,
revision ids and hashes, category paths, timestamp — and never a title, a body, a
proposal payload or a secret.

A receiver that wants the knowledge asks for it, with a credential of its own, and
is answered according to what that credential may read. The webhook tells it that
something happened and where to look.

Delivery follows the per-workspace ledger sequence, which is gapless and totally
ordered. Each webhook carries a cursor over it, exactly as an agent carries one
through `knowledge_changes` (ADR 0010): a delivery that fails does not advance the
cursor, so the next attempt resends rather than skips. Deliveries are at least once
and in order; a receiver that must not act twice keys on the event id, which is
stable.

The signature is HMAC-SHA256 over `timestamp.body` with the webhook's secret, in
`X-Knoverge-Signature`. The timestamp is in the signed material so that a captured
body cannot be replayed later, and the receiver is told to compare digests rather
than strings.

The secret is encrypted rather than hashed, with `KNOVERGE_ENCRYPTION_KEY`, because
the server has to recover it to sign. That is the only class of secret in this
product that is recoverable; passwords, session tokens and agent tokens stay
one-way hashed, and the key stays out of the database.

## Consequences

An operator gets a push that says what changed, in order, with nothing in it that
would matter if the endpoint were wrong. The blast radius of a mistyped URL is a
list of identifiers, not the knowledge base.

A receiver has to make a second call to learn what an event was about. That is the
cost, and it is the same cost the change feed already imposes on agents, for the
same reason: the second call is where authorisation happens.

Nothing is delivered to a host the operator did not configure (rule 12). Private
addresses are not blocked, because a self-hosted installation delivering to another
service on its own network is the normal case rather than the suspicious one; the
security document says so rather than leaving it implied.
