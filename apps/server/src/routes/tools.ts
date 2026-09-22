import { TOOLS, type ToolName } from '@knoverge/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { csrfUnlessBearer } from '../plugins/security.ts';
import { activityDigest, knowledgeBriefing } from './briefing.ts';
import { knowledgeChanges } from './changes.ts';
import { eventsList } from './events.ts';
import { knowledgeIndex, workspaceManifest } from './manifest.ts';
import type { Services } from '../services.ts';
import { knowledgeDiff, knowledgeGet, knowledgeHistory, knowledgeSearch } from './knowledge.ts';
import {
  knowledgeProposeCreate,
  knowledgeProposeDelete,
  knowledgeProposeSupersede,
  knowledgeProposeUpdate,
  proposalApprove,
  proposalGet,
  proposalList,
  proposalReject,
  proposalWithdraw,
} from './proposals.ts';
import { taxonomyList } from './taxonomy.ts';

/**
 * What every tool handler looks like from the outside.
 *
 * The input is already parsed against the tool's schema, and the request is
 * there for the things a handler needs that the input does not carry: who is
 * calling, which workspace, and the idempotency key.
 */
export type ToolHandler = (
  services: Services,
  request: FastifyRequest,
  input: never,
) => Promise<unknown>;

/**
 * One handler per tool, and the compiler insists on exactly that set: a tool
 * added to the contract with no handler here fails to build, rather than
 * being advertised and then answering 404.
 */
const HANDLERS: Record<ToolName, ToolHandler> = {
  workspace_manifest: workspaceManifest as ToolHandler,
  knowledge_index: knowledgeIndex as ToolHandler,
  knowledge_briefing: knowledgeBriefing as ToolHandler,
  taxonomy_list: taxonomyList as ToolHandler,
  knowledge_search: knowledgeSearch as ToolHandler,
  knowledge_get: knowledgeGet as ToolHandler,
  knowledge_history: knowledgeHistory as ToolHandler,
  knowledge_diff: knowledgeDiff as ToolHandler,
  knowledge_propose_create: knowledgeProposeCreate as ToolHandler,
  knowledge_propose_update: knowledgeProposeUpdate as ToolHandler,
  knowledge_propose_delete: knowledgeProposeDelete as ToolHandler,
  knowledge_propose_supersede: knowledgeProposeSupersede as ToolHandler,
  proposal_list: proposalList as ToolHandler,
  proposal_get: proposalGet as ToolHandler,
  proposal_approve: proposalApprove as ToolHandler,
  proposal_reject: proposalReject as ToolHandler,
  proposal_withdraw: proposalWithdraw as ToolHandler,
  knowledge_changes: knowledgeChanges as ToolHandler,
  events_list: eventsList as ToolHandler,
  activity_digest: activityDigest as ToolHandler,
};

/** The handler a tool runs, for the MCP adapter as well as for HTTP. */
export function handlerFor(name: ToolName): ToolHandler {
  return HANDLERS[name];
}

/**
 * A proposal that nobody has looked at yet.
 *
 * 202 rather than 200, so a caller can tell "recorded" from "done" without
 * reading the status field. The status is what says so: a rejection and a
 * withdrawal also write no item, and answering 202 to those would say
 * somebody still has to decide when somebody just did.
 */
function stillPending(output: unknown): boolean {
  const proposal = (output as { proposal?: { status?: unknown } } | null)?.proposal;
  return proposal?.status === 'pending';
}

/**
 * `POST /v1/<tool_name>` for every tool, from the contract itself.
 *
 * Rule 11: the schemas are declared once in `packages/contracts`, and both
 * transports are generated from them, so a tool cannot mean one thing over
 * MCP and another over HTTP. A read that a browser also uses keeps its `GET`
 * alongside this, over the same handler (ADR 0011).
 */
export function registerToolRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  for (const tool of TOOLS) {
    const handler = HANDLERS[tool.name];
    r.post(
      `/v1/${tool.name}`,
      {
        // A tool call from a browser session still needs the token; one with a
        // bearer credential does not, because there is no cookie to ride on.
        ...(tool.readOnly ? {} : { onRequest: csrfUnlessBearer(app) }),
        schema: {
          operationId: tool.name,
          description: tool.description,
          body: tool.input,
          response: tool.readOnly ? { 200: tool.output } : { 200: tool.output, 202: tool.output },
        },
      },
      async (request, reply) => {
        const output = await handler(services, request, request.body as never);
        if (!tool.readOnly && stillPending(output)) reply.code(202);
        return output;
      },
    );
  }
}
