import { z } from 'zod';

export const ActorType = z.enum(['human', 'agent', 'system']);
export type ActorType = z.infer<typeof ActorType>;

export const MembershipRole = z.enum(['owner', 'admin', 'reviewer', 'viewer']);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const UserStatus = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatus>;

export const Locale = z.enum(['en', 'ru']);
export type Locale = z.infer<typeof Locale>;

/** BCP 47 primary language subtag, lower case. */
export const LanguageTag = z.string().regex(/^[a-z]{2,3}$/);

export const WorkspaceSlug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lower-case letters, digits and hyphens');
