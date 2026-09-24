# ADR 0021: AI providers are configured in the product, not in the environment

- Status: Accepted
- Date: 2026-09-24

## Context

Embeddings arrived configured by `KNOVERGE_EMBEDDING_PROVIDER`, `_BASE_URL` and `_MODEL`. That is the twelve-factor answer and it is right for the things it was chosen for: the database URL, the ledger key, the port. Those are decided once by whoever installs the product and are wrong to change while it runs.

An AI provider is not that. An operator points at a server, finds out whether it answers, sees which models it holds, picks one, changes their mind when the answers are poor, and tries another. Every step of that is iteration, and every step of it needed a container restart.

Worse, the restart is a lie about what is happening underneath. The embedding profile machinery (ADR 0020) already changes models without a gap: a new profile fills while the old one answers, and they swap when the last chunk is embedded. That design only means anything if a model can be changed while the product is running.

The counter-argument is real: configuration in a database is configuration somebody cannot see in their `docker-compose.yml`, cannot put in version control, and cannot provision declaratively.

## Decision

**The environment provisions. The database decides.**

An `ai_providers` row holds what a provider is — kind, name, base URL — and an `ai_assignments` row says which provider and model answer for a purpose. Both are instance-level, because one Ollama server is not a property of a workspace.

On start, if no provider exists and `KNOVERGE_EMBEDDING_*` is set, the row is created from it. That keeps an existing deployment working, and keeps declarative provisioning possible for somebody who wants it: put the variables in the compose file and the first start does what they say.

After that the database is the answer, and the variables are not read again. An operator who changes them and restarts will find nothing has happened, which is why the settings page says where the configuration came from.

### What the product asks a provider

**Whether it is there**, before anything is saved: the wizard probes the URL the operator typed rather than a row that does not exist yet. A connection form that can only test what has already been saved teaches people to save things that do not work.

**What it holds.** Ollama's `/api/tags` returns each model with a `capabilities` list, so the picker for embeddings offers the models that say `embedding` and no others. A generative model chosen as an embedding model is a mistake that costs a rebuild and answers nothing useful; the list is the place to prevent it.

**Whether the model works.** One embedding of one short text, reported with the dimension it came back with and how long it took. The dimension is the number the whole index hangs from and nobody configures it, so seeing it is the difference between believing the connection works and knowing it.

### What is deliberately not here

**Stored API keys.** Ollama has none, so this change needs no secret storage and does not add any. OpenAI and every hosted provider do, and a key in a database needs encryption at rest, a key to encrypt it with, and a decision about what happens when that key is lost. That is its own change; until it is made, the OpenAI card is shown and is not connectable.

**A generation provider.** The purpose column allows one, and nothing reads it: generation has no consumer until Milestone 8. It is in the model because leaving it out would mean a migration to add one row type, and in the interface as a section that says it is not yet available.

**An instance administrator.** There is no such role. These routes require `workspace.admin` somewhere, which is the same rule workspace creation uses and is the same widening: anybody who can administer a workspace can administer the installation's AI. For a self-hosted installation with one team that is the truth anyway; for anything larger it is a role that has to exist, and this is a note that it does not.

## Consequences

- An operator connects a provider, sees its models, picks one and watches the first vectors appear, without touching the host.
- The compose file stops being the record of what is configured. The settings page says where each setting came from — the environment on first start, or somebody in the interface since.
- `POST /v1/admin/ai.providers.check` makes the server fetch a URL the caller chose. The caller already administers a workspace, the scheme is restricted to http and https, and the answer is a shape rather than a body — but it is a request the server would not otherwise make, and it is listed here so it is not discovered later.
- Changing a model is a rebuild: the new profile fills while the old answers. The interface says how many chunks are left, because that is the only number that says when the change has taken effect.
- Nothing about this is required. With no provider the page says so and names what still works, which is most of the product.
