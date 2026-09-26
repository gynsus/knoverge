/** The piles a person works through, in the order they are offered. */
export const VIEWS = ['all', 'unreviewed', 'unsourced', 'disputed', 'stale'] as const;
export type View = (typeof VIEWS)[number];
