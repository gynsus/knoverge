import type {
  AiProviderId,
  AiProviderKind,
  AiProviderOrigin,
  AiPurpose,
} from '@knoverge/contracts';
import type { AiAssignmentRecord, AiProviderRecord, AiRepository } from '@knoverge/core';
import { asc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { aiAssignments, aiProviders } from '../schema/ai.ts';

function toProvider(row: typeof aiProviders.$inferSelect): AiProviderRecord {
  return {
    ...row,
    id: row.id as AiProviderId,
    kind: row.kind as AiProviderKind,
    origin: row.origin as AiProviderOrigin,
  };
}

function toAssignment(row: typeof aiAssignments.$inferSelect): AiAssignmentRecord {
  return {
    purpose: row.purpose as AiPurpose,
    providerId: row.providerId as AiProviderId,
    model: row.model,
    updatedAt: row.updatedAt,
  };
}

export function createAiRepository(db: Database): AiRepository {
  const one = async (where: ReturnType<typeof eq>) => {
    const rows = await db.select().from(aiProviders).where(where).limit(1);
    return rows[0] ? toProvider(rows[0]) : null;
  };

  return {
    async providers() {
      const rows = await db.select().from(aiProviders).orderBy(asc(aiProviders.createdAt));
      return rows.map(toProvider);
    },

    findProvider: (id) => one(eq(aiProviders.id, id)),
    findProviderByUrl: (baseUrl) => one(eq(aiProviders.baseUrl, baseUrl)),

    async insertProvider(record) {
      await db.insert(aiProviders).values(record);
    },

    async updateProvider(id, patch) {
      await db.update(aiProviders).set(patch).where(eq(aiProviders.id, id));
    },

    async recordCheck(id, outcome) {
      await db
        .update(aiProviders)
        .set({ lastCheckedAt: outcome.lastCheckedAt, lastError: outcome.lastError })
        .where(eq(aiProviders.id, id));
    },

    async deleteProvider(id) {
      await db.delete(aiProviders).where(eq(aiProviders.id, id));
    },

    async assignments() {
      const rows = await db.select().from(aiAssignments).orderBy(asc(aiAssignments.purpose));
      return rows.map(toAssignment);
    },

    async assignment(purpose) {
      const rows = await db
        .select()
        .from(aiAssignments)
        .where(eq(aiAssignments.purpose, purpose))
        .limit(1);
      return rows[0] ? toAssignment(rows[0]) : null;
    },

    async setAssignment(record) {
      // One answer per purpose, so the second time somebody picks a model it
      // replaces the first rather than adding to it.
      await db
        .insert(aiAssignments)
        .values(record)
        .onConflictDoUpdate({
          target: aiAssignments.purpose,
          set: { providerId: record.providerId, model: record.model, updatedAt: record.updatedAt },
        });
    },

    async removeAssignment(purpose) {
      await db.delete(aiAssignments).where(eq(aiAssignments.purpose, purpose));
    },
  };
}
