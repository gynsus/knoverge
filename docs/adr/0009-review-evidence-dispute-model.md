# ADR 0009: Orthogonal review, evidence and dispute state instead of a single trust value

- Status: Accepted
- Date: 2026-09-19

## Context

The initial model had one `trust` field:

```text
unverified | agent_supported | human_verified | source_verified | disputed
```

It conflates independent facts. An item can be human-reviewed, backed by three sources and currently disputed at the same time; a single value cannot express that, and moving it to `disputed` loses the fact that a human reviewed it. `source_verified` also overstated what a stored source hash proves: bytes unchanged, not truth.

## Decision

Replace `trust` with three orthogonal properties on every knowledge item, in PostgreSQL and in frontmatter:

```text
review:   unreviewed | agent_reviewed | human_reviewed
evidence: none | source_backed | corroborated
disputed: true | false
```

Semantics:

- `review` records the strongest review the current revision received: none, approval by an agent with `knowledge.approve`, or approval or edit by a human. A new revision resets `review` unless a human committed it.
- `evidence` records provenance strength: no source reference, at least one source reference with a locator or hash, or two or more independent sources (or independent agents) supporting the same claim.
- `disputed` is true while an unresolved `contradicts` relation or an explicit human doubt exists. Resolving the contradiction clears it.

`confidence` stays a separate claim-level estimate on proposals and source references.

A `trust_score` for ranking is computed from review, evidence, dispute and freshness with configurable weights. It is never stored as canonical data and never appears in frontmatter.

Frontmatter example:

```yaml
review: human_reviewed
evidence: source_backed
disputed: false
```

## Consequences

### Positive

- No information loss when states change independently.
- Filters and policy scopes can target each axis (for example "require review for anything unreviewed and disputed").
- Ranking stays tunable without schema changes.

### Negative

- Three fields instead of one in every contract and in frontmatter.
- Agents need a short explanation in the MCP prompts.

## Rejected alternatives

### Keep a single `trust` enum

Simplest, but loses information and cannot express common combinations. Rejected.

### Three enums including a `dispute_state` enum

Equivalent, but a boolean is sufficient for the dispute axis. Rejected for simplicity.
