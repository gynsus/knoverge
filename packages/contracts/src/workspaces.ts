import { z } from 'zod';

import { DisplayName, Email, Password } from './auth.ts';
import { ActorType, LanguageTag, MembershipRole, UserStatus, WorkspaceSlug } from './identity.ts';
import { ItemType } from './knowledge.ts';
import { PermissionAction } from './policy.ts';
import { ActorId, UserId, WorkspaceId } from './ids.ts';

export const WorkspaceSummary = z.object({
  id: WorkspaceId,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  default_language: LanguageTag,
  created_at: z.iso.datetime(),
  /**
   * Set while the workspace is archived: kept and readable, closed to changes.
   *
   * A date rather than a flag, because "since when" is the first thing asked
   * of a workspace nobody has written to in a while.
   */
  archived_at: z.iso.datetime().nullable(),
  /** The caller's role, when the caller is a person. An agent has none. */
  role: MembershipRole.nullable(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

/**
 * Who acted, for turning an actor id into a name.
 *
 * The event ledger and a category's provenance record an actor id and nothing
 * else, so without this every history line reads `act_01J8Z…`. It carries a
 * name and a type and no more: the members list and the agents list are
 * administration and stay behind their permissions, while who has acted in a
 * workspace is already visible to anybody who can read its events.
 */
export const ActorSummary = z.object({
  id: ActorId,
  type: ActorType,
  display_name: z.string(),
  /** Set when the actor is an agent, so an interface can link to it. */
  agent_id: z.string().nullable(),
  /** True once the actor can no longer act. */
  disabled: z.boolean(),
});
export type ActorSummary = z.infer<typeof ActorSummary>;

export const ActorsResponse = z.object({ actors: z.array(ActorSummary) });
export type ActorsResponse = z.infer<typeof ActorsResponse>;

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

/**
 * One workspace as a list of them shows it.
 *
 * Carries what somebody needs to choose between workspaces without opening
 * each one: how much is in it, how many agents reach it, and when anything
 * last happened. The counts are of the whole workspace rather than of what
 * this caller may see — they say how big it is, not what is readable — and a
 * list of workspaces you belong to gives nothing away that membership did not.
 */
export const WorkspaceListEntry = z.object({
  id: WorkspaceId,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  default_language: LanguageTag,
  created_at: z.iso.datetime(),
  /** Set while the workspace is archived: kept and readable, closed to changes. */
  archived_at: z.iso.datetime().nullable(),
  /** The caller's role in this workspace. Never null here: it is theirs. */
  role: MembershipRole,
  item_count: z.number().int().nonnegative(),
  agent_count: z.number().int().nonnegative(),
  /** The newest event in this workspace's ledger, or null if nothing happened yet. */
  last_activity_at: z.iso.datetime().nullable(),
  /**
   * What the caller may do in this workspace, after roles, tiers and grants.
   *
   * The same answer `workspace.get` gives for the one they are in, for each of
   * the others. Without it an interface choosing what to offer for a workspace
   * somebody is not in has only the role to go on, which is the second copy of
   * the policy engine that every other screen avoids: a reviewer granted
   * workspace administration explicitly would be shown nothing.
   */
  permissions: z.array(PermissionAction),
});
export type WorkspaceListEntry = z.infer<typeof WorkspaceListEntry>;

export const WorkspacesResponse = z.object({ workspaces: z.array(WorkspaceListEntry) });
export type WorkspacesResponse = z.infer<typeof WorkspacesResponse>;

/**
 * Creates a workspace, with the caller as its owner.
 *
 * The slug is the natural idempotency key: it is unique across the
 * installation, so a resubmitted form is refused rather than silently
 * creating a second workspace under the same name. That is why this request
 * carries no `idempotency_key` of its own.
 */
export const CreateWorkspaceRequest = z.object({
  slug: WorkspaceSlug,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  default_language: LanguageTag.optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

export const CreateWorkspaceResponse = z.object({ workspace: WorkspaceSummary });
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponse>;

export const UpdateWorkspaceRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  default_language: LanguageTag.optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequest>;

/**
 * Archives a workspace, or brings it back.
 *
 * An archived workspace keeps everything and accepts nothing: reading, search
 * and history work as before, and every write is refused, whoever asks. It is
 * reversible, so archiving the wrong one costs a second call and nothing else.
 */
export const ArchiveWorkspaceRequest = z.object({
  archived: z.boolean(),
});
export type ArchiveWorkspaceRequest = z.infer<typeof ArchiveWorkspaceRequest>;

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

/**
 * An administrator setting a member's password, for an installation with no
 * mail server to send a reset link through (ADR 0014).
 *
 * The password is handed over out of band, exactly as `initial_password` works
 * when adding a member. It revokes every session that member holds.
 */
export const ResetMemberPasswordRequest = z.object({
  user_id: UserId,
  new_password: Password,
});
export type ResetMemberPasswordRequest = z.infer<typeof ResetMemberPasswordRequest>;

export const RemoveMemberRequest = z.object({ user_id: UserId });
export type RemoveMemberRequest = z.infer<typeof RemoveMemberRequest>;

/**
 * A compact description of the workspace, for an agent with no context.
 *
 * The first call a client makes: it says what the workspace is, where the two
 * cursors are, what this caller may do, and whether it has synchronised here
 * before. Everything else can be worked out from it.
 */
export const WorkspaceManifestInput = z.object({});
export type WorkspaceManifestInput = z.infer<typeof WorkspaceManifestInput>;

export const WorkspaceManifest = z.object({
  server: z.object({
    name: z.literal('knoverge'),
    version: z.string(),
    contract_version: z.string(),
  }),
  workspace: z.object({
    id: WorkspaceId,
    name: z.string(),
    default_language: z.string(),
    /**
     * True while the workspace accepts no changes.
     *
     * The capabilities below already say so one by one; this says why, so a
     * client can report "the workspace is archived" instead of listing four
     * permissions it does not have.
     */
    archived: z.boolean(),
  }),
  taxonomy_version: z.number().int().nonnegative(),
  /** Positions in the one per-workspace ledger sequence; the names say why. */
  change_sequence: z.number().int().nonnegative(),
  event_sequence: z.number().int().nonnegative(),
  knowledge_types: z.array(ItemType),
  capabilities: z.object({
    can_read: z.boolean(),
    can_propose: z.boolean(),
    can_propose_taxonomy: z.boolean(),
    /** True only when a policy rule grants this actor allow_direct. */
    can_write_direct: z.boolean(),
    can_approve: z.boolean(),
    can_manage_taxonomy: z.boolean(),
    semantic_search: z.boolean(),
  }),
  stats: z.object({
    items: z.number().int().nonnegative(),
    categories: z.number().int().nonnegative(),
    pending_proposals: z.number().int().nonnegative(),
  }),
});
export type WorkspaceManifest = z.infer<typeof WorkspaceManifest>;
