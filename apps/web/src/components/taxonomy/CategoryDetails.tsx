import type { ActorSummary, CategorySummary } from '@knoverge/contracts';
import { Check, Copy, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { copyToClipboard } from '@/lib/password';
import { relativeTime } from '@/lib/relative-time';

export interface CategoryDetailsProps {
  category: CategorySummary;
  /** Every category, for naming the one a merge pointed at. */
  categories: readonly CategorySummary[];
  actors: readonly ActorSummary[];
  canManage: boolean;
  onEdit: () => void;
  onAddChild: () => void;
  onNotice: (message: string, tone: 'status' | 'error') => void;
  childCount: number;
}

/**
 * A category as an object rather than a row.
 *
 * The tree can only show a name and a number. Everything that makes a curated
 * taxonomy different from a folder — what belongs here, what does not, what
 * else it is called, who made it — lives here. For an agent deciding where to
 * file something, the guidance matters more than the tree does.
 */
export function CategoryDetails({
  category,
  categories,
  actors,
  canManage,
  onEdit,
  onAddChild,
  onNotice,
  childCount,
}: CategoryDetailsProps) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const nameOf = (id: string | null) =>
    id === null ? null : (actors.find((a) => a.id === id)?.display_name ?? id);
  const mergedInto = category.merged_into_category_id
    ? categories.find((c) => c.id === category.merged_into_category_id)
    : undefined;

  const copyPath = async () => {
    const ok = await copyToClipboard(category.path);
    setCopied(ok);
    onNotice(ok ? t('taxonomy.path_copied') : t('password.copy_failed'), ok ? 'status' : 'error');
  };

  return (
    <div className="grid content-start gap-5 p-4 sm:p-6">
      <div className="grid gap-2">
        <h3 className="text-lg font-semibold">{category.name}</h3>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
            {category.path}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void copyPath()}
            aria-label={t('taxonomy.copy_path')}
            className="size-7 shrink-0 px-0"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-4" />
            ) : (
              <Copy aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
        {category.description && <p className="text-sm">{category.description}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={category.status === 'active' ? 'default' : 'outline'}>
            {t(`taxonomy.statuses.${category.status}`)}
          </Badge>
          {mergedInto && (
            <span className="text-xs text-muted-foreground">
              {t('taxonomy.merged_into', { name: mergedInto.name })}
            </span>
          )}
        </div>
      </div>

      {canManage && category.status === 'active' && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil aria-hidden="true" className="size-4" />
            {t('taxonomy.edit')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onAddChild}>
            <Plus aria-hidden="true" className="size-4" />
            {t('taxonomy.add_child')}
          </Button>
        </div>
      )}

      <Separator />

      <section className="grid gap-1.5">
        <h4 className="text-sm font-medium">{t('taxonomy.holds')}</h4>
        <p className="text-sm text-muted-foreground">
          {t('taxonomy.items_here', { count: category.item_count })}
          {category.subtree_item_count !== category.item_count &&
            ` · ${t('taxonomy.items_in_branch', { count: category.subtree_item_count })}`}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('taxonomy.children', { count: childCount })}
        </p>
      </section>

      <Guidance title={t('taxonomy.belongs_here')} lines={category.inclusion_guidance} />
      <Guidance title={t('taxonomy.does_not_belong')} lines={category.exclusion_guidance} />

      {category.aliases.length > 0 && (
        <section className="grid gap-1.5">
          <h4 className="text-sm font-medium">{t('taxonomy.aliases')}</h4>
          <ul className="flex flex-wrap gap-1.5">
            {category.aliases.map((alias) => (
              <li key={alias}>
                <Badge variant="outline" className="font-normal">
                  {alias}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Separator />

      <section className="grid gap-1 text-xs text-muted-foreground">
        <h4 className="text-sm font-medium text-foreground">{t('taxonomy.provenance')}</h4>
        <p>
          {t('taxonomy.created_by', {
            who: nameOf(category.created_by_actor_id),
            when: relativeTime(category.created_at, i18n.language),
          })}
        </p>
        {category.approved_by_actor_id && (
          <p>{t('taxonomy.approved_by', { who: nameOf(category.approved_by_actor_id) })}</p>
        )}
        <p>{t('taxonomy.updated', { when: relativeTime(category.updated_at, i18n.language) })}</p>
      </section>
    </div>
  );
}

function Guidance({ title, lines }: { title: string; lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <section className="grid gap-1.5">
      <h4 className="text-sm font-medium">{title}</h4>
      <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}
