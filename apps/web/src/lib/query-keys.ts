/**
 * Query keys shared between a page and the components it opens.
 *
 * Defined away from the components so that a file exporting a key is not also
 * a file exporting a component: React's fast refresh can only replace a module
 * whose exports are all components, and a mixed one reloads the page instead.
 */
export const TAXONOMY_KEY = ['taxonomy'] as const;
export const ACTORS_KEY = ['actors'] as const;
export const TAXONOMY_HISTORY_KEY = ['taxonomy-history'] as const;

export const AGENTS_KEY = ['admin', 'agents'] as const;

/** A person's own sessions, shared by the pages that show and end them. */
export const SESSIONS_KEY = ['account', 'sessions'] as const;

/** The AI settings, which every step of the wizard refreshes. */
export const AI_SETTINGS_KEY = ['ai-settings'] as const;

/** Where this workspace pushes word that something happened. */
export const WEBHOOKS_KEY = ['admin', 'webhooks'] as const;

/** Whether this installation keeps copies of itself, and the copies it has. */
export const BACKUP_SETTINGS_KEY = ['admin', 'backup-settings'] as const;
export const BACKUPS_KEY = ['admin', 'backups'] as const;

/** Files a workspace holds, and one of them. */
export const ATTACHMENTS_KEY = ['admin', 'attachments'] as const;
export const ATTACHMENT_KEY = ['admin', 'attachment'] as const;
