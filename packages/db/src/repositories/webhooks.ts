import type { EventType, WebhookId, WorkspaceId } from '@knoverge/contracts';
import type { Tx, WebhookPatch, WebhookRecord, WebhookRepository } from '@knoverge/core';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { webhooks } from '../schema/webhooks.ts';
import { asTx } from '../unit-of-work.ts';

function toRecord(row: typeof webhooks.$inferSelect): WebhookRecord {
  return {
    id: row.id as WebhookId,
    workspaceId: row.workspaceId as WorkspaceId,
    url: row.url,
    secretCiphertext: row.secretCiphertext,
    eventTypes: (row.eventTypes as EventType[]) ?? [],
    status: row.status as WebhookRecord['status'],
    cursor: row.cursor,
    failures: row.failures,
    nextAttemptAt: row.nextAttemptAt,
    lastDeliveryAt: row.lastDeliveryAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createWebhookRepository(db: Database): WebhookRepository {
  return {
    async insert(tx: Tx, webhook: WebhookRecord) {
      await asTx(tx)
        .insert(webhooks)
        .values({
          id: webhook.id,
          workspaceId: webhook.workspaceId,
          url: webhook.url,
          secretCiphertext: webhook.secretCiphertext,
          eventTypes: [...webhook.eventTypes],
          status: webhook.status,
          cursor: webhook.cursor,
          failures: webhook.failures,
          nextAttemptAt: webhook.nextAttemptAt,
          lastDeliveryAt: webhook.lastDeliveryAt,
          lastError: webhook.lastError,
          createdAt: webhook.createdAt,
          updatedAt: webhook.updatedAt,
        });
    },
    async update(tx: Tx, workspaceId: WorkspaceId, id: WebhookId, patch: WebhookPatch) {
      await asTx(tx)
        .update(webhooks)
        .set({
          ...(patch.url !== undefined ? { url: patch.url } : {}),
          ...(patch.secretCiphertext !== undefined
            ? { secretCiphertext: patch.secretCiphertext }
            : {}),
          ...(patch.eventTypes !== undefined ? { eventTypes: [...patch.eventTypes] } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
          ...(patch.failures !== undefined ? { failures: patch.failures } : {}),
          ...(patch.nextAttemptAt !== undefined ? { nextAttemptAt: patch.nextAttemptAt } : {}),
          ...(patch.lastDeliveryAt !== undefined ? { lastDeliveryAt: patch.lastDeliveryAt } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)));
    },
    async remove(tx: Tx, workspaceId: WorkspaceId, id: WebhookId) {
      await asTx(tx)
        .delete(webhooks)
        .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)));
    },
    async findById(workspaceId: WorkspaceId, id: WebhookId) {
      const [row] = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.id, id)));
      return row ? toRecord(row) : null;
    },
    async list(workspaceId: WorkspaceId) {
      const rows = await db
        .select()
        .from(webhooks)
        .where(eq(webhooks.workspaceId, workspaceId))
        .orderBy(asc(webhooks.createdAt));
      return rows.map(toRecord);
    },
    async listDue(now: Date, limit: number) {
      const rows = await db
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.status, 'active'),
            // Never attempted, or the backoff has run out.
            or(isNull(webhooks.nextAttemptAt), lte(webhooks.nextAttemptAt, now)),
          ),
        )
        .orderBy(asc(webhooks.nextAttemptAt))
        .limit(limit);
      return rows.map(toRecord);
    },
  };
}
