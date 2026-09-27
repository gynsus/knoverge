# 30. A retired ledger key still verifies

Date: 2026-09-27

Status: accepted

## Context

Every event carries an HMAC of the previous event's hash and its own canonical
content, keyed with `KNOVERGE_LEDGER_KEY` (ADR 0007). The key never enters the
database, which is what makes the chain worth having: somebody who can write to
PostgreSQL cannot forge an event without it.

Milestone 9 asks for rotation. The obvious implementation is the one the ledger
cannot have: rehash every event with the new key. The table rejects `UPDATE` at the
database level, rule 4 says application code never changes an existing event, and a
ledger that can be rewritten by configuration is not a ledger. Whatever rotation
means here, it does not mean touching what is written.

## Decision

A key is retired, not replaced. Configuration carries a keyring: one signing key
and any number of retired ones.

```text
KNOVERGE_LEDGER_KEY          signs from now on
KNOVERGE_LEDGER_KEY_RETIRED  comma separated; verification only
```

Appends use the signing key. Verification tries the signing key first and falls
back to the retired ones, in the order they are given, and remembers which key last
worked so a long chain costs one HMAC per event rather than one per key per event.

No column records which key signed an event. It could — `hash_version` shows the
shape the idea would take — but adding a key id to what is hashed would be a new
hash version and a migration that rewrote nothing while making every old event
verify differently. Trying the keys costs one extra HMAC at the boundary where the
rotation happened and nothing anywhere else, and it keeps the stored event exactly
as it was.

The chain itself needs no help across a rotation. `prev_event_hash` stores the
value of the previous event's hash, whatever key produced it, so the links are
key-independent; only the recomputation of each event's own hash needs the right
key. A workspace's genesis hash is keyed too, so the first event is checked against
every key's genesis.

## Consequences

Rotation is: generate a key, move the old value into `KNOVERGE_LEDGER_KEY_RETIRED`,
put the new one in `KNOVERGE_LEDGER_KEY`, restart. Nothing is rewritten and nothing
stops verifying. `knoverge ledger verify` says which events verified, and — because
a failure is now ambiguous between a tampered row and a key nobody kept — reports
whether a retired key was needed.

Dropping a retired key is a decision with a consequence, and the deployment guide
says it plainly: the events it signed stop being verifiable. They are still there
and still readable; what is lost is the proof that nobody edited them. That is the
same sentence the security document already carries about losing the key
altogether, now with a narrower scope.

An operator can tell which keys are in force without printing them: `knoverge
ledger keys` shows a fingerprint of each, which is an HMAC over a fixed string. A
fingerprint identifies a key without being one.
