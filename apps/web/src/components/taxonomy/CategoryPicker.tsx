import type { CategorySummary } from '@knoverge/contracts';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { depthOf, matchOf } from '@/lib/taxonomy-tree';
import { cn } from '@/lib/utils';

export interface CategoryPickerProps {
  categories: readonly CategorySummary[];
  /** The chosen category, or null for none. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** Shown when nothing is chosen, and offered as a choice of its own. */
  noneLabel: string;
  label: string;
  /** Categories that may not be chosen, with the reason left to the caller. */
  disabledIds?: readonly string[];
  id?: string;
}

/**
 * Choosing a category out of a workspace's whole taxonomy.
 *
 * A `<select>` is fine for five categories and unusable at a hundred: it
 * cannot be searched, and the indentation that carries the hierarchy is the
 * first thing a native dropdown throws away. This searches the same four
 * fields the tree does, so "pixel arch" finds
 * projects/pixel-brisbane/architecture.
 *
 * The list is a listbox with roving `aria-selected`, so a screen reader hears
 * how many options there are and which one is current.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  noneLabel,
  label,
  disabledIds = [],
  id,
}: CategoryPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const blocked = useMemo(() => new Set(disabledIds), [disabledIds]);
  const chosen = categories.find((c) => c.id === value) ?? null;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return categories
      .filter((c) => c.status === 'active' && !blocked.has(c.id))
      .filter((c) => needle === '' || matchOf(c, needle) !== null)
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [categories, query, blocked]);

  const choose = (next: string | null) => {
    onChange(next);
    setQuery('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          id={id}
          aria-label={label}
          className="h-9 w-full justify-between font-normal"
        >
          <span className="truncate">{chosen ? chosen.name : noneLabel}</span>
          <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <div className="relative border-b border-border">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('taxonomy.picker_search')}
            placeholder={t('taxonomy.picker_search')}
            className="border-0 pl-9 focus-visible:outline-none"
          />
        </div>
        <ul role="listbox" aria-label={label} className="max-h-64 overflow-y-auto p-1">
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={() => choose(null)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Check
                aria-hidden="true"
                className={cn('size-4 shrink-0', value !== null && 'invisible')}
              />
              {noneLabel}
            </button>
          </li>
          {shown.map((category) => (
            <li key={category.id}>
              <button
                type="button"
                role="option"
                aria-selected={category.id === value}
                onClick={() => choose(category.id)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                // The indentation is the hierarchy; the path below it is the
                // answer to "which Architecture is this one".
                style={{ paddingLeft: `${depthOf(category.path) * 12 + 8}px` }}
              >
                <Check
                  aria-hidden="true"
                  className={cn('size-4 shrink-0', category.id !== value && 'invisible')}
                />
                <span className="grid min-w-0">
                  <span className="truncate">{category.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{category.path}</span>
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-2 py-3 text-sm text-muted-foreground">
              {t('taxonomy.picker_empty')}
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
