# 33. A provider key is kept the way a signing secret is

Date: 2026-09-28

Status: accepted

## Context

ADR 0021 moved AI providers out of the environment and into the product: an
operator points at a server, finds out whether it answers, sees which models it
holds and changes their mind, and none of that should need a container restart.
One thing stayed behind. A key could not be typed in, because storing one needed
encryption at rest, a key to encrypt it with, and an answer for what happens when
that is lost.

All three arrived with webhooks. `KNOVERGE_ENCRYPTION_KEY` exists, `packages/auth`
seals and opens under it, and ADR 0029 settled what a lost key means: the secret
is set again. The reason had become a sentence nobody had reread.

Meanwhile the gap had teeth. The one key an installation can supply reaches the
provider whose address matches `KNOVERGE_EMBEDDING_BASE_URL`, and nothing else —
so Milestone 12's transcription, which only an OpenAI-compatible server can do,
was unusable with any hosted one unless it happened to sit at the embedding
provider's address. A feature reachable only by coincidence is not reachable.

## Decision

`ai_providers.api_key_ciphertext`, sealed with AES-256-GCM under
`KNOVERGE_ENCRYPTION_KEY`, exactly as a webhook's signing secret is. The wizard
has a field for it, for the one kind of provider that has any use for one.

**Sealed, not hashed.** The key goes out on every call, so it has to be readable
again. It is the second recoverable secret in this product and the last one that
should be: passwords, session tokens and agent tokens stay one-way.

**Write-only.** It is given here and never served back. The settings page says
whether a provider has one, never which — a screen that showed it would put a
credential in a browser's history, a screenshot and a support ticket. Reopening
the wizard on a provider that has one offers to replace it rather than
pre-filling it.

**Absent means keep.** A save that leaves the field out keeps whatever the
provider has, so renaming a provider does not silently drop the credential it was
working with. `null` clears it, which is how a provider that stopped needing one
says so.

**No key, no field.** Without a `KNOVERGE_ENCRYPTION_KEY` the field is not shown
and the service refuses a key rather than storing it in clear, and the screen says
which variable to set. A credential in a column anybody with the database can read
is worse than a feature that is not configured.

**The environment still works, second.** What the provider holds comes first;
`KNOVERGE_EMBEDDING_API_KEY` remains the fallback for the address it names, so an
installation that has been sending one since before this existed keeps working
without anybody re-entering anything.

## Consequences

A hosted provider — an OpenAI-compatible gateway, a Whisper service, anything
behind a token — can be connected from the interface, which is what ADR 0021 said
configuration here means.

The sealed value is part of what the built provider is cached by, so a key changed
on the settings page is noticed by a worker in another process rather than after a
restart.

Losing `KNOVERGE_ENCRYPTION_KEY` means the stored keys cannot be opened. That is
the same loss webhooks already have and the same remedy: set the key again on the
provider. Nothing knowledge-bearing depends on it.

`DATA_MODEL.md` section 30 carries the column, and `SECURITY.md` lists it beside
the webhook secret as the second thing `KNOVERGE_ENCRYPTION_KEY` protects.
