import { z } from 'zod';

import { DisplayName, Email, Password } from './auth.ts';
import { LanguageTag, MembershipRole, UserStatus } from './identity.ts';
import { PermissionAction } from './policy.ts';
import { ActorId, UserId, WorkspaceId } from './ids.ts';

export const WorkspaceSummary = z.object({
  id: WorkspaceId,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  default_language: LanguageTag,
  created_at: z.iso.datetime(),
  /** The caller's role, when the caller is a person. An agent has none. */
  role: MembershipRole.nullable(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceResponse = z.object({
  workspace: WorkspaceSummary,
  /**
   * What the caller may do in this workspace, after roles, tiers and grants.
   *
   * An interface that decides from the role instead is a second copy of the
   * policy engine and drifts from it: a reviewer explicitly granted an action
   * would still be shown a disabled control, and a viewer would be shown forms
   * whose every submission is refused.
   */
  permissions: z.array(PermissionAction),
});
export type WorkspaceResponse = z.infer<typeof WorkspaceResponse>;

export const UpdateWorkspaceRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  default_language: LanguageTag.optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequest>;

export const MemberSummary = z.object({
  user_id: UserId,
  actor_id: ActorId,
  email: Email,
  display_name: DisplayName,
  role: MembershipRole,
  status: UserStatus,
  joined_at: z.iso.datetime(),
  last_login_at: z.iso.datetime().nullable(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

export const MembersResponse = z.object({ members: z.array(MemberSummary) });
export type MembersResponse = z.infer<typeof MembersResponse>;

/**
 * Adds a member. Self-hosted installations have no mail server by default, so
 * an existing user is added by email and a new one is created with a password
 * the administrator passes on out of band.
 */
export const AddMemberRequest = z.object({
  email: Email,
  /** Retry-safe: the same key with the same body returns the first result. */
  idempotency_key: z.string().optional(),
  role: MembershipRole.default('reviewer'),
  display_name: DisplayName.optional(),
  /** Required when the email belongs to no existing user. */
  initial_password: Password.optional(),
});
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

export const UpdateMemberRequest = z.object({
  user_id: UserId,
  role: MembershipRole,
});
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

export const RemoveMemberRequest = z.object({ user_id: UserId });
export type RemoveMemberRequest = z.infer<typeof RemoveMemberRequest>;
