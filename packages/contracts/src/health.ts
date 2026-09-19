import { z } from 'zod';

export const HealthCheck = z.object({
  status: z.enum(['ok', 'failed']),
  latency_ms: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;

export const LiveResponse = z.object({
  status: z.literal('ok'),
});
export type LiveResponse = z.infer<typeof LiveResponse>;

export const ReadyResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.object({
    database: HealthCheck,
    data_dir: HealthCheck,
  }),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;
