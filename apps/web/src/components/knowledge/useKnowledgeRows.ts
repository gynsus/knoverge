import type { EvidenceState, ItemType, ReviewState } from '@knoverge/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { adminApi } from '../../api/admin.ts';
import type { RowItem } from './KnowledgeRow.tsx';

export const ITEMS_KEY = ['knowledge', 'items'] as const;

export interface Narrowing {
  query: string;
  category: string;
  type: string;
  state: string;
  /** `none` is the pile with nothing saying where it came from. */
  evidence: string;
}

/**
 * The rows the list shows, from whichever source can answer.
 *
 * A query ranks; the filters narrow. Search does both at once, so while a
 * query is in force the browse list steps aside rather than the two fighting
 * over the same rows — they are ordered by different things.
 *
 * Both answers become the same shape, because the reader is asking the same
 * question either way: which of these do I want to read.
 */
export function useKnowledgeRows({ query, category, type, state, evidence }: Narrowing) {
  const browse = useInfiniteQuery({
    queryKey: [...ITEMS_KEY, category, type, state, evidence],
    queryFn: ({ pageParam, signal }) =>
      adminApi.knowledge.list(
        {
          cursor: pageParam as string | undefined,
          category: category || undefined,
          type: type || undefined,
          reviewState: state || undefined,
          evidenceState: evidence || undefined,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: query === '',
  });

  const found = useQuery({
    queryKey: [...ITEMS_KEY, 'search', query, category, type, state, evidence],
    queryFn: () =>
      adminApi.knowledge.search({
        query,
        category_paths: category ? [category] : [],
        types: type ? [type as ItemType] : [],
        statuses: ['active'],
        languages: [],
        review_states: state ? [state as ReviewState] : [],
        evidence_states: evidence ? [evidence as EvidenceState] : [],
        include_disputed: true,
        limit: 50,
        include_snippets: true,
      }),
    enabled: query !== '',
  });

  const rows: RowItem[] = useMemo(() => {
    if (query !== '') {
      return (found.data?.results ?? []).map((hit) => ({
        id: hit.item_id,
        title: hit.title,
        type: hit.type,
        categories: hit.category_paths,
        reviewState: hit.review_state,
        evidenceState: hit.evidence_state,
        disputed: hit.disputed,
        updatedAt: hit.updated_at,
        ...(hit.snippet ? { snippet: hit.snippet } : {}),
      }));
    }
    return (browse.data?.pages.flatMap((page) => page.items) ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      categories: entry.categories,
      reviewState: entry.review_state,
      evidenceState: entry.evidence_state,
      disputed: entry.disputed,
      updatedAt: entry.updated_at,
      revisionNumber: entry.revision_number,
    }));
  }, [query, found.data, browse.data]);

  return {
    rows,
    loading: query === '' ? browse.isPending : found.isPending,
    error: query === '' ? browse.error : found.error,
    /** Only browsing pages; a ranked answer is one page of the best hits. */
    hasMore: query === '' && browse.hasNextPage,
    loadingMore: browse.isFetchingNextPage,
    loadMore: () => void browse.fetchNextPage(),
  };
}
