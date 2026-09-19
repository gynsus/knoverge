# ADR 0005: Single application process and React SPA

- Status: Accepted
- Date: 2026-09-19

## Context

The initial specification used Next.js for the web application and listed `api`, `mcp` and `web` as separate services. For a self-hosted product the number of containers, ports and configuration values is a large part of the installation cost. Next.js brings its own server runtime and a heavy image for what is, in this product, an authenticated single-page application with no SEO requirement.

## Decision

1. The web application is a React single-page application built with Vite and served as static files by the Fastify server process.
2. HTTP API, MCP endpoint, static web bundle and background worker run in one Node.js process (`apps/server`). `KNOVERGE_ROLE` allows splitting the worker into a second container later without code changes.
3. A complete installation is one `knoverge` container plus PostgreSQL, on one port.
4. The CLI (`apps/cli`) is shipped inside the same image.

## Consequences

### Positive

- `docker compose up` with two services and one port.
- No cross-origin configuration between web and API.
- Smaller image, simpler reverse-proxy configuration.
- One codebase for the web bundle regardless of where it is served.

### Negative

- No server-side rendering; initial load requires JavaScript. Acceptable for an authenticated tool.
- A single process shares CPU between requests and jobs; the `worker` role exists for the case where this matters.

## Rejected alternatives

### Next.js

Rejected: unnecessary runtime and image weight for an authenticated SPA, and a third service to operate.

### Separate API and MCP processes

Rejected for MVP: both call the same domain services; separating them adds deployment complexity without isolation benefits.
