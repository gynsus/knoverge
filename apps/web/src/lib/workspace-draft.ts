import type { WorkspaceListEntry } from '@knoverge/contracts';

/** Everything about a workspace that somebody edits, as text they typed. */
export interface WorkspaceDraft {
  name: string;
  slug: string;
  description: string;
  language: string;
}

export const emptyWorkspaceDraft: WorkspaceDraft = {
  name: '',
  slug: '',
  description: '',
  language: 'en',
};

export function draftOf(workspace: WorkspaceListEntry): WorkspaceDraft {
  return {
    name: workspace.name,
    slug: workspace.slug,
    description: workspace.description ?? '',
    language: workspace.default_language,
  };
}
