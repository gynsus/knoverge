import {
  GardeningRunsResponse,
  GardeningSettingsResponse,
  RunGardeningResponse,
  SaveGardeningSettingsRequest,
  type GardeningRun,
  type GardeningRuleName,
  type GardeningSettings,
} from '@knoverge/contracts';
import type { GardeningRunRecord, GardeningSettingsView } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function settings(view: GardeningSettingsView): GardeningSettings {
  return {
    enabled: view.enabled,
    interval_hours: view.intervalHours,
    max_findings_per_run: view.maxFindingsPerRun,
    max_findings_per_rule: view.maxFindingsPerRule,
    last_run_at: view.lastRunAt?.toISOString() ?? null,
    rules: view.rules as GardeningRuleName[],
  };
}

function run(record: GardeningRunRecord): GardeningRun {
  return {
    id: record.id,
    trigger: record.trigger,
    started_at: record.startedAt.toISOString(),
    finished_at: record.finishedAt?.toISOString() ?? null,
    findings_filed: record.findingsFiled,
    reached_cap: record.reachedCap,
    error: record.error,
    rules: record.rules.map((result) => ({
      rule: result.rule,
      examined: result.examined,
      found: result.found,
      filed: result.filed,
      limited: result.limited,
    })),
    notices: record.notices.map((notice) => ({
      rule: notice.rule,
      subject_type: notice.subjectType,
      subject_id: notice.subjectId,
      reason: notice.reason,
    })),
  };
}

/**
 * Gardening administration.
 *
 * Administration, not a tool: never offered to an agent and with no MCP name to
 * match (rule 11, ADR 0011). `workspace.admin`, which no agent trust tier
 * holds — and per workspace, unlike the backup settings, because a workspace is
 * the unit of knowledge and of review (ADR 0042).
 */
export function registerAdminGardeningRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/admin/gardening.settings',
    { schema: { response: { 200: GardeningSettingsResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      return { settings: settings(await services.gardening.settings(actor.context.workspaceId)) };
    },
  );

  r.get(
    '/v1/admin/gardening.runs',
    { schema: { response: { 200: GardeningRunsResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      const records = await services.gardening.runs(actor.context.workspaceId);
      return { runs: records.map(run) };
    },
  );

  r.post(
    '/v1/admin/gardening.save',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: SaveGardeningSettingsRequest, response: { 200: GardeningSettingsResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      const body = request.body;
      const view = await services.gardening.save(actor.context.workspaceId, {
        enabled: body.enabled,
        intervalHours: body.interval_hours,
        maxFindingsPerRun: body.max_findings_per_run,
        maxFindingsPerRule: body.max_findings_per_rule,
      });
      request.log.info(
        {
          workspaceId: actor.context.workspaceId,
          enabled: view.enabled,
          intervalHours: view.intervalHours,
          maxFindingsPerRun: view.maxFindingsPerRun,
          maxFindingsPerRule: view.maxFindingsPerRule,
        },
        'gardening settings changed',
      );
      return { settings: settings(view) };
    },
  );

  r.post(
    '/v1/admin/gardening.run',
    { onRequest: csrfUnlessBearer(app), schema: { response: { 200: RunGardeningResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'workspace.admin');
      // Runs whether or not the schedule is on, because somebody who has just
      // configured this wants to watch one happen rather than wait a day to
      // find out whether it works — the same reason **Take one now** sits
      // beside the backup schedule.
      const record = await services.gardening.run(actor.context.workspaceId, 'requested');
      // Every ending, including the quiet one: a run that filed nothing is the
      // answer an operator asked for.
      request.log.info(
        {
          workspaceId: actor.context.workspaceId,
          runId: record.id,
          filed: record.findingsFiled,
          reachedCap: record.reachedCap,
          error: record.error,
        },
        'gardening run finished',
      );
      return {
        run: run(record),
        settings: settings(await services.gardening.settings(actor.context.workspaceId)),
      };
    },
  );
}
