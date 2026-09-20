import { z } from 'zod';

import { Locale, MembershipRole, UserStatus } from './identity.ts';
import { SessionId, UserId, WorkspaceId } from './ids.ts';

export const Email = z.string().trim().toLowerCase().email().max(320);

/** Minimum 12 characters; length is the only rule (NIST SP 800-63B). */
export const Password = z.string().min(12).max(200);

export const DisplayName = z.string().trim().min(1).max(120);

export const UserSummary = z.object({
  id: UserId,
  email: Email,
  display_name: DisplayName,
  locale: Locale,
  status: UserStatus,
  created_at: z.iso.datetime(),
  last_login_at: z.iso.datetime().nullable(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const MembershipSummary = z.object({
  workspace_id: WorkspaceId,
  workspace_slug: z.string(),
  workspace_name: z.string(),
  role: MembershipRole,
});
export type MembershipSummary = z.infer<typeof MembershipSummary>;

export const AuthStatusResponse = z.object({
  /** True until the first administrator exists. */
  bootstrap_required: z.boolean(),
  authenticated: z.boolean(),
});
export type AuthStatusResponse = z.infer<typeof AuthStatusResponse>;

export const CsrfResponse = z.object({ token: z.string() });
export type CsrfResponse = z.infer<typeof CsrfResponse>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const MeResponse = z.object({
  user: UserSummary,
  memberships: z.array(MembershipSummary),
  session: z.object({ id: SessionId, expires_at: z.iso.datetime() }),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ChangePasswordRequest = z.object({
  current_password: z.string().min(1).max(200),
  new_password: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/**
 * Changing the address the account signs in with.
 *
 * The current password is required, so a stolen session is not enough to move
 * an account somewhere its owner cannot follow. There is no confirmation link:
 * an installation has no mail server to send one with (ADR 0014).
 */
export const ChangeEmailRequest = z.object({
  current_password: z.string().min(1).max(200),
  new_email: Email,
});
export type ChangeEmailRequest = z.infer<typeof ChangeEmailRequest>;

export const SessionSummary = z.object({
  id: SessionId,
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  user_agent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionsResponse = z.object({ sessions: z.array(SessionSummary) });
export type SessionsResponse = z.infer<typeof SessionsResponse>;

export const RevokeSessionRequest = z.object({ session_id: SessionId });
export type RevokeSessionRequest = z.infer<typeof RevokeSessionRequest>;

export const BootstrapRequest = z.object({
  email: Email,
  password: Password,
  display_name: DisplayName,
  locale: Locale.default('en'),
  workspace: z.object({
    slug: z.string(),
    name: z.string().trim().min(1).max(120),
  }),
});
export type BootstrapRequest = z.infer<typeof BootstrapRequest>;

export const BootstrapResponse = z.object({
  user_id: UserId,
  workspace_id: WorkspaceId,
});
export type BootstrapResponse = z.infer<typeof BootstrapResponse>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;
