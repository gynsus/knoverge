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
    patch: Partial<Pick<AiProviderRecord, 'kind' | 'name' | 'baseUrl' | 'origin' | 'updatedAt'>>,
  ): Promise<void>;
  recordCheck(id: AiProviderId, outcome: ProviderCheckOutcome): Promise<void>;
  deleteProvider(id: AiProviderId): Promise<void>;

  assignments(): Promise<AiAssignmentRecord[]>;
  assignment(purpose: AiPurpose): Promise<AiAssignmentRecord | null>;
  setAssignment(record: AiAssignmentRecord): Promise<void>;
  removeAssignment(purpose: AiPurpose): Promise<void>;
}
