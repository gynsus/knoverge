# ADR 0001: Canonical Markdown/Git plus PostgreSQL Event Ledger

- Status: Accepted
- Date: 2026-09-19

## Context

Knoverge needs:

- human-readable portable knowledge;
- version history;
- rollback;
- agent attribution;
- review workflow;
- search;
- permissions;
- reconciliation state;
- immutable audit.

No single storage engine provides all of these properties cleanly.

Using only a vector database would make canonical knowledge opaque and weakly versioned.

Using only Git would make structured permissions, sync sessions, search metadata, proposals, and event queries awkward.

Using only PostgreSQL would make manual portability and Git-native history less natural.

## Decision

Use two authoritative stores for different responsibilities.

### Git-backed Markdown

Authoritative for canonical knowledge content and revision history.

### PostgreSQL

Authoritative for:

- identity;
- permissions;
- taxonomy;
- current metadata;
- revision metadata;
- proposals;
- provenance;
- append-only event ledger;
- sync state;
- relations;
- derived indexes.

Search indexes and embeddings are rebuildable projections.

## Consequences

### Positive

- human-readable repository;
- easy backup/export;
- strong diffs;
- explicit operational model;
- rich audit;
- scalable querying.

### Negative

- cross-store transaction complexity;
- integrity reconciliation is required;
- writes require coordination/locking.

## Mitigation

Use an explicit `Operation` record and recovery process for any write touching both stores.

Test crash windows deliberately.

## Rejected alternatives

### Vector database as canonical store

Rejected because embeddings are retrieval projections, not durable truth.

### PostgreSQL-only canonical Markdown

Viable, but does not provide the desired Git-native revision/portability model.

### Git-only system

Rejected because proposal workflow, permissions, high-volume events, reconciliation and structured search need operational storage.
