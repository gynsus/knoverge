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

/** The titles of the items a set of relations points at. */
function useTargetTitles(relations: readonly FrontmatterRelation[]): Map<string, string> {
  const ids = [...new Set(relations.map((relation) => relation.target as string))];
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
  const titles = useTargetTitles(relations);
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
  const titles = useTargetTitles(relations);
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
