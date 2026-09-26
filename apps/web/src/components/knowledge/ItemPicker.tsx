import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { adminApi } from '../../api/admin.ts';

/**
 * Choosing another item in the workspace, by searching for it.
 *
 * A relation names an item by id, and an id is not something anybody has in
 * their head. The search is the same one the knowledge page uses, so whatever
 * finds an item there finds it here.
 */
export function ItemPicker({
  value,
  title,
  onChange,
  label,
}: {
  /** The chosen item's id, or null. */
  value: string | null;
  /** Its title, when the caller already knows it. */
  title: string | null;
  onChange: (id: string, title: string) => void;
  label: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Only once there is something to search for: an empty query would ask the
  // server to rank the whole workspace to fill a dropdown nobody opened.
  const results = useQuery({
    queryKey: ['knowledge', 'picker', query],
    queryFn: () => adminApi.knowledge.search({ query, limit: 10 }),
    enabled: open && query.trim().length > 1,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={label}
          className="w-full justify-between font-normal"
        >
          <span className="min-w-0 truncate">{title ?? value ?? t('knowledge.pick_item')}</span>
          <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-0">
        <div className="relative border-b border-border">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Its own label, not the list's: both search boxes are on the
            // screen at once, and a reader told "Search knowledge" twice has
            // been told nothing (WEB_UI.md rule 2g).
            aria-label={t('knowledge.pick_search')}
            placeholder={t('knowledge.pick_search')}
            className="border-0 pl-9 shadow-none focus-visible:outline-none"
          />
        </div>
        <ul role="listbox" aria-label={label} className="max-h-72 overflow-y-auto p-1">
          {query.trim().length <= 1 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {t('knowledge.pick_item_hint')}
            </li>
          ) : results.isPending ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">{t('common.loading')}</li>
          ) : (results.data?.results.length ?? 0) === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">{t('knowledge.no_matches')}</li>
          ) : (
            results.data?.results.map((hit) => (
              <li key={hit.item_id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={hit.item_id === value}
                  onClick={() => {
                    onChange(hit.item_id, hit.title);
                    setOpen(false);
                  }}
                  className="w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                >
                  <span className="block truncate">{hit.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {hit.category_paths.join(', ') || t('knowledge.uncategorised')}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
