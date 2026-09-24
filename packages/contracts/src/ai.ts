import { z } from 'zod';

import { AiProviderId } from './ids.ts';

/**
 * How the product talks to a provider.
 *
 * Not the vendor's name: `openai_compatible` is the `/v1/embeddings` shape that
 * most gateways and local servers imitate, and what is behind it may be nothing
 * to do with OpenAI.
 */
export const AiProviderKind = z.enum(['ollama', 'openai_compatible']);
export type AiProviderKind = z.infer<typeof AiProviderKind>;

/** What a provider is asked to do. Only `embedding` has a consumer today. */
export const AiPurpose = z.enum(['embedding', 'generation']);
export type AiPurpose = z.infer<typeof AiPurpose>;

/**
 * Who configured this, which is the question an operator asks first when the
 * compose file and the interface disagree (ADR 0021).
 */
export const AiProviderOrigin = z.enum(['environment', 'interface']);
export type AiProviderOrigin = z.infer<typeof AiProviderOrigin>;

/**
 * Restricted to http and https because the server fetches it.
 *
 * Not restricted to a private address: pointing at a machine on the internet is
 * a legitimate thing for an operator to want, and a list of addresses the
 * product refuses to talk to is a list it would get wrong.
 */
export const ProviderBaseUrl = z
  .url()
  .max(512)
  .refine((value) => /^https?:$/u.test(new URL(value).protocol), 'must be http or https');

export const ProviderName = z.string().trim().min(1).max(64);
export const ModelName = z.string().trim().min(1).max(200);

export const AiProviderSummary = z.object({
  id: AiProviderId,
  kind: AiProviderKind,
  name: ProviderName,
  base_url: ProviderBaseUrl,
  origin: AiProviderOrigin,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** The last probe, or null when nothing has asked yet. */
  last_checked_at: z.iso.datetime().nullable(),
  /** Why the last probe failed, or null when it did not. */
  last_error: z.string().nullable(),
});
export type AiProviderSummary = z.infer<typeof AiProviderSummary>;

export const AiAssignment = z.object({
  purpose: AiPurpose,
  provider_id: AiProviderId,
  model: ModelName,
  updated_at: z.iso.datetime(),
});
export type AiAssignment = z.infer<typeof AiAssignment>;

export const AiSettings = z.object({
  providers: z.array(AiProviderSummary),
  assignments: z.array(AiAssignment),
  /**
   * Whether anything can be embedded right now.
   *
   * The interface says this rather than working it out, because "a provider
   * exists" and "embeddings happen" are not the same claim.
   */
  embeddings_enabled: z.boolean(),
});
export type AiSettings = z.infer<typeof AiSettings>;

export const SaveAiProviderRequest = z.object({
  /** Absent creates; present replaces what that provider is. */
  provider_id: AiProviderId.optional(),
  kind: AiProviderKind,
  name: ProviderName,
  base_url: ProviderBaseUrl,
});
export type SaveAiProviderRequest = z.infer<typeof SaveAiProviderRequest>;

export const RemoveAiProviderRequest = z.object({ provider_id: AiProviderId });
export type RemoveAiProviderRequest = z.infer<typeof RemoveAiProviderRequest>;

/**
 * Probe an address.
 *
 * Takes a URL rather than a saved provider so the wizard can test what somebody
 * typed before it is stored.
 */
export const CheckAiProviderRequest = z.object({
  kind: AiProviderKind,
  base_url: ProviderBaseUrl,
});
export type CheckAiProviderRequest = z.infer<typeof CheckAiProviderRequest>;

export const CatalogueModel = z.object({
  name: ModelName,
  size: z.number().int().nonnegative().optional(),
  /** What the provider says the model is for; empty when it does not say. */
  capabilities: z.array(z.string().max(64)),
});
export type CatalogueModel = z.infer<typeof CatalogueModel>;

export const CheckAiProviderResponse = z.object({
  reachable: z.boolean(),
  /** The provider's own version, when it offers one. */
  version: z.string().max(120).nullable(),
  models: z.array(CatalogueModel),
  /** Why it is not reachable, in one line, or null when it is. */
  error: z.string().nullable(),
});
export type CheckAiProviderResponse = z.infer<typeof CheckAiProviderResponse>;

export const AssignAiModelRequest = z.object({
  purpose: AiPurpose,
  provider_id: AiProviderId,
  model: ModelName,
});
export type AssignAiModelRequest = z.infer<typeof AssignAiModelRequest>;

export const UnassignAiModelRequest = z.object({ purpose: AiPurpose });
export type UnassignAiModelRequest = z.infer<typeof UnassignAiModelRequest>;

/**
 * One embedding of one short text.
 *
 * The dimension is the number the whole index hangs from and nobody configures
 * it, so seeing it is the difference between believing a connection works and
 * knowing it.
 */
export const TestAiModelRequest = z.object({
  /**
   * The address, not a saved provider: testing a model is testing an address
   * and a model, and the wizard has to be able to do it before it saves.
   */
  kind: AiProviderKind,
  base_url: ProviderBaseUrl,
  model: ModelName,
  /** Absent uses a fixed phrase; a caller may send their own. */
  text: z.string().trim().min(1).max(2000).optional(),
});
export type TestAiModelRequest = z.infer<typeof TestAiModelRequest>;

export const TestAiModelResponse = z.object({
  ok: z.boolean(),
  dimensions: z.number().int().positive().nullable(),
  latency_ms: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type TestAiModelResponse = z.infer<typeof TestAiModelResponse>;

export const AiSettingsResponse = z.object({ ai: AiSettings });
export type AiSettingsResponse = z.infer<typeof AiSettingsResponse>;
