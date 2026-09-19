# ADR 0003: One contract for MCP and HTTP

- Status: Accepted
- Date: 2026-09-19

## Context

The specification promised an HTTP API that "mirrors" MCP but did not define it. Two hand-written surfaces would double schemas, tests, permission checks and documentation, and drift over time.

MCP tool names also used dots (`knowledge.search`). Several MCP hosts and OpenAI-compatible function calling only accept `^[a-zA-Z0-9_-]+$`, so dotted names would be unusable for part of the target audience.

## Decision

1. Tool names use `^[a-z][a-z0-9_]*$`, for example `knowledge_search`.
2. Every tool is defined once in `packages/contracts` as a Zod input schema, output schema, permission requirement and error set.
3. The MCP adapter registers each contract as a tool. The HTTP adapter exposes each contract as `POST /v1/<tool_name>` with the same JSON body and response.
4. Errors are the same object on both transports; HTTP additionally maps codes to status values.
5. Auth, account and admin operations that are not agent-facing live under `/v1/auth/*` and `/v1/admin/*` in the same RPC style and are not MCP tools.
6. `/v1/ui/*` endpoints exist for the web application only and carry no stability promise.
7. OpenAPI is generated from the contracts.
8. Contract tests run each tool through both adapters.

## Consequences

### Positive

- One schema, one permission path, one test matrix.
- Non-MCP clients (scripts, automations, the web UI) get exactly the agent contract.
- Tool names are portable across hosts.

### Negative

- The HTTP API is not RESTful; resource-oriented clients must adapt.
- Admin operations are a second, smaller surface.

## Rejected alternatives

### Separate REST API

Idiomatic HTTP, but two contracts to maintain. Rejected for MVP; a REST facade could be generated later if there is demand.

### MCP only

Simplest, but the web UI and automations need HTTP anyway. Rejected.
