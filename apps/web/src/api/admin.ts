import type {
  ActorsResponse,
  SyncRunsResponse,
  AddMemberRequest,
  ApproveProposalRequest,
  AgentResponse,
  AgentsResponse,
  CategoryResponse,
  CreateAgentRequest,
  CreateCategoryRequest,
  CreateKnowledgeRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  CredentialsResponse,
  DeleteKnowledgeRequest,
  IssueCredentialRequest,
  IssueCredentialResponse,
  KnowledgeDiffResponse,
  KnowledgeListResponse,
  KnowledgeResponse,
  MergeCategoryRequest,
  MoveCategoryRequest,
  OkResponse,
  PolicyRuleResponse,
  PolicyRulesResponse,
  ProposalResponse,
  ProposalResult,
  ProposalsResponse,
  RejectProposalRequest,
  RevisionsResponse,
  SessionsResponse,
  TaxonomyListResponse,
  MembersResponse,
  UpdateAgentRequest,
  UpsertPolicyRuleRequest,
  UpdateCategoryRequest,
  UpdateKnowledgeRequest,
  UpdateMemberRequest,
  UpdateWorkspaceRequest,
  WorkspaceResponse,
  WorkspacesResponse,
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
  sync: {
    runs: (signal?: AbortSignal) => apiGet<SyncRunsResponse>('/v1/admin/sync.list', signal),
    proposals: (syncSessionId: string) =>
      apiPost<ProposalsResponse>('/v1/proposal_list', {
        sync_session_id: syncSessionId,
        limit: 200,
      }),
  },
  taxonomy: {
    list: (signal?: AbortSignal) =>
      apiGet<TaxonomyListResponse>('/v1/taxonomy.list?include_archived=true', signal),
    create: (body: CreateCategoryRequest) =>
      apiPost<CategoryResponse>('/v1/admin/taxonomy.create', body),
    update: (body: UpdateCategoryRequest) =>
      apiPost<CategoryResponse>('/v1/admin/taxonomy.update', body),
    move: (body: MoveCategoryRequest) => apiPost<CategoryResponse>('/v1/admin/taxonomy.move', body),
    merge: (body: MergeCategoryRequest) =>
      apiPost<CategoryResponse>('/v1/admin/taxonomy.merge', body),
    restore: (categoryId: string) =>
      apiPost<CategoryResponse>('/v1/admin/taxonomy.restore', { category_id: categoryId }),
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
    list: (signal?: AbortSignal) => apiGet<WorkspacesResponse>('/v1/workspaces.list', signal),
    actors: (signal?: AbortSignal) => apiGet<ActorsResponse>('/v1/actors.list', signal),
    create: (body: CreateWorkspaceRequest) =>
      apiPost<CreateWorkspaceResponse>('/v1/admin/workspace.create', body),
    update: (body: UpdateWorkspaceRequest) =>
      apiPost<OkResponse>('/v1/admin/workspace.update', body),
    // Named explicitly, because this is reached from a list where the
    // workspace acted on is often not the one being looked at.
    archive: (workspaceId: string, archived: boolean) =>
      apiPost<OkResponse>('/v1/admin/workspace.archive', { archived }, workspaceId),
    members: (signal?: AbortSignal) => apiGet<MembersResponse>('/v1/admin/members.list', signal),
    addMember: (body: AddMemberRequest) => apiPost<MembersResponse>('/v1/admin/members.add', body),
    updateMember: (body: UpdateMemberRequest) =>
      apiPost<OkResponse>('/v1/admin/members.update', body),
    resetMemberPassword: (userId: string, newPassword: string) =>
      apiPost<OkResponse>('/v1/admin/members.reset_password', {
        user_id: userId,
        new_password: newPassword,
      }),
    removeMember: (userId: string) =>
      apiPost<OkResponse>('/v1/admin/members.remove', { user_id: userId }),
  },
  knowledge: {
    list: (cursor: string | undefined, signal?: AbortSignal) =>
      apiGet<KnowledgeListResponse>(
        cursor ? `/v1/knowledge.list?cursor=${encodeURIComponent(cursor)}` : '/v1/knowledge.list',
        signal,
      ),
    get: (itemId: string, signal?: AbortSignal) =>
      apiGet<KnowledgeResponse>(`/v1/knowledge.get?item_id=${encodeURIComponent(itemId)}`, signal),
    revisions: (itemId: string, signal?: AbortSignal) =>
      apiGet<RevisionsResponse>(
        `/v1/knowledge.revisions?item_id=${encodeURIComponent(itemId)}`,
        signal,
      ),
    diff: (itemId: string, from: string, to: string, signal?: AbortSignal) =>
      apiGet<KnowledgeDiffResponse>(
        `/v1/knowledge.diff?item_id=${encodeURIComponent(itemId)}&from_revision_id=${encodeURIComponent(from)}&to_revision_id=${encodeURIComponent(to)}`,
        signal,
      ),
    create: (body: CreateKnowledgeRequest) =>
      apiPost<KnowledgeResponse>('/v1/admin/knowledge.create', body),
    update: (body: UpdateKnowledgeRequest) =>
      apiPost<KnowledgeResponse>('/v1/admin/knowledge.update', body),
    remove: (body: DeleteKnowledgeRequest) =>
      apiPost<KnowledgeResponse>('/v1/admin/knowledge.delete', body),
    restore: (itemId: string) =>
      apiPost<KnowledgeResponse>('/v1/admin/knowledge.restore', { item_id: itemId }),
  },
  proposals: {
    list: (
      status: string | undefined,
      options: { syncSessionId?: string } = {},
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (options.syncSessionId) query.set('sync_session_id', options.syncSessionId);
      const search = query.toString();
      return apiGet<ProposalsResponse>(
        search ? `/v1/proposal.list?${search}` : '/v1/proposal.list',
        signal,
      );
    },
    get: (proposalId: string, signal?: AbortSignal) =>
      apiGet<ProposalResponse>(
        `/v1/proposal.get?proposal_id=${encodeURIComponent(proposalId)}`,
        signal,
      ),
    approve: (body: ApproveProposalRequest) =>
      apiPost<ProposalResult>('/v1/proposal_approve', body),
    reject: (body: RejectProposalRequest) => apiPost<ProposalResult>('/v1/proposal_reject', body),
  },
  account: {
    sessions: (signal?: AbortSignal) => apiGet<SessionsResponse>('/v1/auth/sessions', signal),
    revokeSession: (sessionId: string) =>
      apiPost<OkResponse>('/v1/auth/sessions/revoke', { session_id: sessionId }),
    changeEmail: (currentPassword: string, newEmail: string) =>
      apiPost<OkResponse>('/v1/auth/email', {
        current_password: currentPassword,
        new_email: newEmail,
      }),
    changePassword: (currentPassword: string, newPassword: string) =>
      apiPost<OkResponse>('/v1/auth/password', {
        current_password: currentPassword,
        new_password: newPassword,
      }),
  },
};
