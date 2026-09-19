import type {
  AddMemberRequest,
  AgentResponse,
  AgentsResponse,
  CategoryResponse,
  CreateAgentRequest,
  CreateCategoryRequest,
  CredentialsResponse,
  IssueCredentialRequest,
  IssueCredentialResponse,
  MoveCategoryRequest,
  OkResponse,
  PolicyRuleResponse,
  PolicyRulesResponse,
  SessionsResponse,
  TaxonomyListResponse,
  MembersResponse,
  UpdateAgentRequest,
  UpsertPolicyRuleRequest,
  UpdateCategoryRequest,
  UpdateMemberRequest,
  UpdateWorkspaceRequest,
  WorkspaceResponse,
} from '@knoverge/contracts';

import { apiGet, apiPost } from './client.ts';

export const adminApi = {
  agents: {
    list: (signal?: AbortSignal) => apiGet<AgentsResponse>('/v1/admin/agents.list', signal),
    create: (body: CreateAgentRequest) => apiPost<AgentResponse>('/v1/admin/agents.create', body),
    update: (body: UpdateAgentRequest) => apiPost<AgentResponse>('/v1/admin/agents.update', body),
    credentials: (agentId: string, signal?: AbortSignal) =>
      apiGet<CredentialsResponse>(
        `/v1/admin/agents.credentials?agent_id=${encodeURIComponent(agentId)}`,
        signal,
      ),
    issue: (body: IssueCredentialRequest) =>
      apiPost<IssueCredentialResponse>('/v1/admin/agents.credentials.issue', body),
    revoke: (credentialId: string) =>
      apiPost<OkResponse>('/v1/admin/agents.credentials.revoke', { credential_id: credentialId }),
  },
  taxonomy: {
    list: (signal?: AbortSignal) =>
      apiGet<TaxonomyListResponse>('/v1/taxonomy.list?include_archived=true', signal),
    create: (body: CreateCategoryRequest) =>
      apiPost<CategoryResponse>('/v1/admin/taxonomy.create', body),
    update: (body: UpdateCategoryRequest) =>
      apiPost<CategoryResponse>('/v1/admin/taxonomy.update', body),
    move: (body: MoveCategoryRequest) => apiPost<CategoryResponse>('/v1/admin/taxonomy.move', body),
    archive: (categoryId: string) =>
      apiPost<CategoryResponse>('/v1/admin/taxonomy.archive', { category_id: categoryId }),
  },
  policy: {
    rules: (signal?: AbortSignal) => apiGet<PolicyRulesResponse>('/v1/admin/policy.rules', signal),
    upsertRule: (body: UpsertPolicyRuleRequest) =>
      apiPost<PolicyRuleResponse>('/v1/admin/policy.rules.upsert', body),
    deleteRule: (ruleId: string) =>
      apiPost<OkResponse>('/v1/admin/policy.rules.delete', { rule_id: ruleId }),
  },
  workspace: {
    get: (signal?: AbortSignal) => apiGet<WorkspaceResponse>('/v1/workspace.get', signal),
    update: (body: UpdateWorkspaceRequest) =>
      apiPost<OkResponse>('/v1/admin/workspace.update', body),
    members: (signal?: AbortSignal) => apiGet<MembersResponse>('/v1/admin/members.list', signal),
    addMember: (body: AddMemberRequest) => apiPost<MembersResponse>('/v1/admin/members.add', body),
    updateMember: (body: UpdateMemberRequest) =>
      apiPost<OkResponse>('/v1/admin/members.update', body),
    removeMember: (userId: string) =>
      apiPost<OkResponse>('/v1/admin/members.remove', { user_id: userId }),
  },
  account: {
    sessions: (signal?: AbortSignal) => apiGet<SessionsResponse>('/v1/auth/sessions', signal),
    revokeSession: (sessionId: string) =>
      apiPost<OkResponse>('/v1/auth/sessions/revoke', { session_id: sessionId }),
    changePassword: (currentPassword: string, newPassword: string) =>
      apiPost<OkResponse>('/v1/auth/password', {
        current_password: currentPassword,
        new_password: newPassword,
      }),
  },
};
