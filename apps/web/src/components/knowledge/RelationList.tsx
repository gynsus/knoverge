import type { FrontmatterRelation, KnowledgeItemId, RelationType } from '@knoverge/contracts';
import { RelationType as Types } from '@knoverge/contracts';
import { useQueries } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { adminApi } from '../../api/admin.ts';
import { ItemPicker } from './ItemPicker.tsx';

/** The titles of a set of items, so a list of ids can be read. */
function useItemTitles(wanted: readonly string[]): Map<string, string> {
  const ids = [...new Set(wanted)];
  const answers = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['knowledge', 'items', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => adminApi.knowledge.get(id, signal),
    })),
  });
  return new Map(
    answers.flatMap((answer, index) =>
      answer.data ? [[ids[index] as string, answer.data.item.title]] : [],
    ),
  );
}

/**
 * How this item connects to others.
 *
 * Named, not listed as ids. A relation that reads `relates_to
 * kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3` tells a reader nothing they can act on, and
 * the title is one request away.
 */
export function RelationList({
  relations,
  onOpen,
}: {
  relations: readonly FrontmatterRelation[];
  /** Opens the item a relation points at. */
  onOpen: (itemId: string) => void;
}) {
  const { t } = useTranslation();
  const titles = useItemTitles(relations.map((relation) => relation.target));
  if (relations.length === 0)
    return <p className="text-sm text-muted-foreground">{t('knowledge.no_relations')}</p>;
  return (
    <ul className="grid gap-2 text-sm">
      {relations.map((relation, index) => (
        <li key={index} className="flex flex-wrap items-baseline gap-2">
          <Badge variant="outline" className="font-normal">
            {t(`knowledge.relation_types.${relation.type}`)}
          </Badge>
          <button
            type="button"
            onClick={() => onOpen(relation.target)}
            className="min-w-0 truncate text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {titles.get(relation.target) ?? relation.target}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Which items contradict this one.
 *
 * The other end of a contradiction, which the relations list cannot show: the
 * relation is recorded on the item that reported it, and this item's file
 * carries `disputed_by` instead (ADR 0022). Without it, the disputed badge
 * appears with nothing to read next to it.
 */
export function DisputedBy({
  itemIds,
  onOpen,
}: {
  itemIds: readonly string[];
  onOpen: (itemId: string) => void;
}) {
  const { t } = useTranslation();
  const titles = useItemTitles(itemIds);
  if (itemIds.length === 0) return null;
  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted/40 p-3">
      <p className="text-sm font-medium">{t('knowledge.disputed_by')}</p>
      <ul className="grid gap-1.5 text-sm">
        {itemIds.map((id) => (
          <li key={id} className="flex min-w-0">
            <button
              type="button"
              onClick={() => onOpen(id)}
              className="min-w-0 truncate text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {titles.get(id) ?? id}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('knowledge.disputed_explainer')}</p>
    </div>
  );
}

/** Adding and removing relations. */
export function RelationEditor({
  relations,
  onChange,
  selfId,
}: {
  relations: readonly FrontmatterRelation[];
  onChange: (relations: FrontmatterRelation[]) => void;
  /** This item, which may not point at itself. */
  selfId: string;
}) {
  const { t } = useTranslation();
  const titles = useItemTitles(relations.map((relation) => relation.target));
  const [picked, setPicked] = useState<Map<number, string>>(new Map());

  const replace = (index: number, patch: Partial<FrontmatterRelation>) =>
    onChange(relations.map((relation, i) => (i === index ? { ...relation, ...patch } : relation)));

  return (
    <div className="grid gap-2">
      {relations.map((relation, index) => (
        <div key={index} className="grid gap-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={relation.type}
              onChange={(e) => replace(index, { type: e.target.value as RelationType })}
              aria-label={t('knowledge.relation_type')}
              className="sm:w-52"
            >
              {Types.options.map((type) => (
                <option key={type} value={type}>
                  {t(`knowledge.relation_types.${type}`)}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(relations.filter((_, i) => i !== index))}
              aria-label={t('knowledge.remove_relation', {
                what: titles.get(relation.target) ?? relation.target,
              })}
              className="text-destructive"
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          </div>
          <ItemPicker
            value={relation.target}
            title={picked.get(index) ?? titles.get(relation.target) ?? null}
            label={t('knowledge.relation_target')}
            onChange={(id, title) => {
              // Nothing relates to itself: the statement is empty, and it
              // would render as an item linking to the page it is on.
              if (id === selfId) return;
              setPicked((current) => new Map(current).set(index, title));
              replace(index, { target: id as KnowledgeItemId });
            }}
          />
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          onChange([...relations, { type: 'relates_to', target: '' as KnowledgeItemId }])
        }
      >
        <Plus aria-hidden="true" className="size-4" />
        {t('knowledge.add_relation')}
      </Button>
    </div>
  );
}
