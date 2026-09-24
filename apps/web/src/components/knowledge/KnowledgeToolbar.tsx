import { ItemType as ItemTypes, ReviewState as ReviewStates } from '@knoverge/contracts';
import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

/**
 * What narrows the list.
 *
 * The query is typed here and committed by the page, which keeps this a
 * control rather than a thing that knows about the address.
 */
export function KnowledgeToolbar({
  typed,
  onType,
  category,
  type,
  state,
  categories,
  onFilter,
}: {
  typed: string;
  onType: (value: string) => void;
  category: string;
  type: string;
  state: string;
  /** Every category path, for the branch filter. */
  categories: readonly string[];
  onFilter: (key: 'category' | 'type' | 'state', value: string) => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLInputElement>(null);

  // `/` is where a developer's hand goes to search. Not while they are
  // already typing somewhere, which is how that shortcut becomes a nuisance.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      box.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
      <div className="relative min-w-0 flex-1 lg:max-w-md">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={box}
          type="search"
          value={typed}
          onChange={(e) => onType(e.target.value)}
          aria-label={t('knowledge.search')}
          placeholder={t('knowledge.search')}
          className="pr-9 pl-9"
        />
        {typed !== '' && (
          <button
            type="button"
            onClick={() => onType('')}
            aria-label={t('knowledge.search_clear')}
            className="absolute top-1/2 right-3 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select
          value={category}
          onChange={(e) => onFilter('category', e.target.value)}
          aria-label={t('knowledge.filter_category')}
        >
          <option value="">{t('knowledge.all_categories')}</option>
          {categories.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </Select>
        <Select
          value={type}
          onChange={(e) => onFilter('type', e.target.value)}
          aria-label={t('knowledge.filter_type')}
        >
          <option value="">{t('knowledge.all_types')}</option>
          {ItemTypes.options.map((option) => (
            <option key={option} value={option}>
              {t(`knowledge.types.${option}`)}
            </option>
          ))}
        </Select>
        <Select
          value={state}
          onChange={(e) => onFilter('state', e.target.value)}
          aria-label={t('knowledge.filter_state')}
        >
          <option value="">{t('knowledge.all_states')}</option>
          {ReviewStates.options.map((option) => (
            <option key={option} value={option}>
              {t(`knowledge.review.${option}`)}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
