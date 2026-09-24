# ADR 0020: The search index is chunked, monolingual, and works with embeddings switched off

- Status: Accepted
- Date: 2026-09-24

## Context

Milestone 6 is hybrid search. Three questions had to be settled before any of it could be built, because each one decides the shape of the index rather than a detail inside it.

**Where the index is granular.** Today `search_documents` holds one row per item: the whole title weighted above the whole body, in one `tsvector`. That is enough to rank titles and short items, and it is the wrong unit for two things M6 needs. A long document matches a query on a sentence buried in it and then offers no way to say *where*; and an embedding of four thousand words is an average of everything the document says, which is a vector close to nothing in particular.

**Whether search crosses languages.** A Russian query does not find an English item today, because a lexical index matches words and those are different words. Embeddings can bridge that — but only with a multilingual model, and choosing one is a commitment: it constrains which providers can be used, it is usually larger, and its monolingual quality is generally worse than a model trained for one language.

**What happens with no AI provider.** Rule 9 says the core runs without an LLM: search included. So the index cannot be designed around embeddings being present.

## Decision

**The unit of the index is a chunk. Search is monolingual by design. Embeddings are an optional second opinion over an index that works without them.**

### Chunks

`search_documents` becomes `search_chunks`: one row per chunk, ordinal within the item, each with the same pair of generated vectors the item row has today — one in the item's language, one `simple` and unstemmed.

The splitter is **deterministic and model-free**: paragraphs on blank lines, adjacent ones merged up to a target size, an over-long paragraph split on sentence boundaries and, failing that, on a character count. Same text in, same chunks out, on any machine and any version — which is what makes `knoverge db reindex` able to rebuild the index from the canonical files and get the same index back. A splitter that asked a model would make the index unreproducible, and an index nobody can reproduce is a second source of truth.

The title is repeated on every chunk, weighted above the chunk text. A query whose words are split between the title and a sentence in the middle of the body has to be able to match.

### Monolingual

A query is parsed in one language and matches text in that language. An item written in another language is not found by it.

This is a decision, not a limitation nobody got to. It means: no multilingual embedding model is required; nothing is tested for cross-language retrieval; and `knowledge_search` says so in its documentation so it is not filed as a defect. A workspace that holds two languages is searched twice.

The `simple` unstemmed vector stays. It is not cross-language retrieval — it is what finds an exact word in an item whose language the query was not parsed in, such as an identifier or a product name.

### Embeddings are optional, and the chunk is what they will hang from

With no provider configured, chunks are still built, the lexical vectors are still generated, and the hybrid score has one component instead of two. `workspace_manifest` already reports `semantic_search: false`; that stays true of the index as well as of the query.

Where a vector is stored is **not settled here**, and deliberately so. This decision is about the unit of the index; the storage of embeddings is decided when embeddings are built, because the choice turns on a question chunking does not raise — whether two profiles may coexist while a workspace is re-embedded under a new model. `DATA_MODEL.md` section 29 already sketches an `EmbeddingProfile` with a status and a separate `Embedding` row per chunk, which buys exactly that and costs a join. Committing to a nullable column on the chunk row inside this change would have pre-empted it with the version that has no answer for a rebuild.

What is settled is that the chunk is the thing an embedding describes. A vector over a whole document is an average of everything it says.

### Where the code lives

`packages/search` stops being a stub and takes what is neither SQL nor orchestration: the chunker, the hybrid score, the embedding profile and its staleness rule. `packages/db` keeps the SQL — that is what a repository is for. `packages/core` keeps the service. `packages/intelligence` keeps the provider port.

This is what `CLAUDE.md` said the package was for. The lexical search built in Milestone 2 went into the repository because it is one SQL query, and the package stayed empty; the moment there is domain logic about retrieval, it belongs where the document says.

## Consequences

- An item's rows grow from one to as many chunks as it has. A workspace of five thousand items is tens of thousands of chunk rows, which is small.
- A hit names a chunk, so a snippet is the part that matched rather than the opening of the document.
- Ranking has to fold chunks back to items: an item is as good as its best chunk, not as good as the sum of them, or a long document wins every query by having more chances.
- Re-indexing is no longer optional after an upgrade that changes the splitter. The migration that introduces chunks leaves the table empty and the server fills it on start, the same way it already fills an index for knowledge recorded before the index existed.
- A bilingual workspace has to be searched once per language. This is the cost of the decision, and it is paid by whoever searches rather than by everyone through a model chosen for a feature most workspaces do not need.

## Alternatives considered

**Keep one row per item and add a second table for chunks.** Both granularities at once, so nothing has to be rewritten. Rejected: two indexes over the same text drift, and every query has to decide which one it believes.

**Chunk by a fixed token count.** What most retrieval stacks do, and it needs a tokeniser that agrees with the model. Rejected because it ties the index to a model that may not be configured at all, and paragraphs are what the author already divided the text into.

**Choose a multilingual embedding model and get cross-language retrieval.** Genuinely useful for a bilingual workspace. Rejected for now by the owner: it decides the model for everyone to serve a case that can be met by searching twice, and it is reversible — the profile on each chunk is exactly what makes changing the model a rebuild rather than a rewrite.
