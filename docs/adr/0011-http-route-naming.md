# ADR 0011: What "one contract" names, and what it does not

- Status: Accepted
- Date: 2026-09-20

## Context

ADR 0003 and rule 11 of `CLAUDE.md` say there is one contract: every MCP tool is exposed over HTTP as `POST /v1/<tool_name>`, with tool names in lowercase letters, digits and underscores.

No implemented route follows that. The surface built in Milestone 1 is `POST /v1/admin/agents.create`, `GET /v1/taxonomy.list`, `POST /v1/auth/login` and so on: dotted names, an `admin` segment, and `GET` with a query string for reads. `docs/HTTP_API.md` states the rule in its first section and then documents the dotted names in sections 5 and 6, so the document contradicts itself.

This was found by an audit, not by a failure, because the two halves of the contract have never met: there is no MCP endpoint yet. When one arrives in Milestone 4, the same operation would have two names, and no client could derive the HTTP path from the tool name.

## Decision

The rule applies to MCP tools, and only to them.

**An operation exposed as an MCP tool is reachable at `POST /v1/<tool_name>`**, with the tool's own name, and its request and response are the tool's schemas. This is the contract ADR 0003 is about: one schema, one permission path, one set of tests, two transports.

**Everything else is not a tool and is not bound by the rule.** Authentication, health, and workspace administration are operations a browser performs on behalf of a person. They are not offered to agents as tools, they have no MCP name to be consistent with, and forcing them into the tool namespace would invent tool names for operations no tool should have.

Those routes keep the shape they have: `POST /v1/admin/<area>.<verb>` for mutations, and `GET` for reads whose input is a handful of filters.

A read that is also an MCP tool gets both: the `GET` a browser finds natural and the `POST /v1/<tool_name>` the contract requires. `taxonomy.list` is the first of these. Two routes over one handler and one schema is a smaller cost than either a browser posting to read a list or a tool name that is not the tool's name.

## Consequences

- `CLAUDE.md` rule 11 and `docs/HTTP_API.md` section 1 say which routes the rule governs, so the document no longer contradicts its own section 6.
- Milestone 4 adds `POST /v1/<tool_name>` for each tool it exposes, including a second route for `taxonomy_list`. Nothing built so far has to be renamed.
- A client reading the generated OpenAPI document sees both, and the tool routes carry the tool names, so a tool name is enough to construct a request.

## Alternatives considered

**Rename every route to `POST /v1/<tool_name>`.** It would make the rule true everywhere, at the cost of tool names for operations that are not tools (`auth_login`, `members_add`), and of a browser posting to read a list. The cost grows with every route, which argued for deciding now rather than later, but the shape it produces is worse than the one it replaces.

**Amend the rule to say nothing about paths.** That gives up what ADR 0003 bought: a client that knows a tool name knows its HTTP path.
