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
