import type {
  AiProviderId,
  AiProviderKind,
  AiProviderOrigin,
  AiPurpose,
} from '@knoverge/contracts';

/** A provider the product can talk to. Instance-level: no workspace. */
export interface AiProviderRecord {
  id: AiProviderId;
  kind: AiProviderKind;
  name: string;
  baseUrl: string;
  origin: AiProviderOrigin;
  /**
   * The key, sealed, or null when the provider needs none.
   *
   * Sealed and not hashed for the reason a webhook's signing secret is: it goes
   * out on every call, so it has to be readable again. Never served — the
   * settings page says whether there is one, never which (ADR 0033).
   */
  apiKeyCiphertext: string | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Which provider and model answer for a purpose. */
export interface AiAssignmentRecord {
  purpose: AiPurpose;
  providerId: AiProviderId;
  model: string;
  updatedAt: Date;
}

/** What the last probe found, kept so the settings page can say. */
export interface ProviderCheckOutcome {
  lastCheckedAt: Date;
  lastError: string | null;
}

export interface AiRepository {
  providers(): Promise<AiProviderRecord[]>;
  findProvider(id: AiProviderId): Promise<AiProviderRecord | null>;
  findProviderByUrl(baseUrl: string): Promise<AiProviderRecord | null>;
  insertProvider(record: AiProviderRecord): Promise<void>;
  updateProvider(
    id: AiProviderId,
    patch: Partial<
      Pick<
        AiProviderRecord,
        'kind' | 'name' | 'baseUrl' | 'origin' | 'apiKeyCiphertext' | 'updatedAt'
      >
    >,
  ): Promise<void>;
  recordCheck(id: AiProviderId, outcome: ProviderCheckOutcome): Promise<void>;
  deleteProvider(id: AiProviderId): Promise<void>;

  assignments(): Promise<AiAssignmentRecord[]>;
  assignment(purpose: AiPurpose): Promise<AiAssignmentRecord | null>;
  setAssignment(record: AiAssignmentRecord): Promise<void>;
  removeAssignment(purpose: AiPurpose): Promise<void>;
}
