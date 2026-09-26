import type { CategorySummary } from '@knoverge/contracts';
import { ArrowDown } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { subtreeIds } from '@/lib/taxonomy-tree';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { CategoryPicker } from './CategoryPicker.tsx';

/** What a change to this category would take with it. */
function reach(categories: readonly CategorySummary[], category: CategorySummary) {
  const ids = subtreeIds(categories, category);
  return { descendants: ids.length - 1, items: category.subtree_item_count };
}

export interface MoveDialogProps {
  category: CategorySummary | null;
  categories: readonly CategorySummary[];
  onClose: () => void;
  onConfirm: (parentId: string | null) => void;
  busy: boolean;
  error: unknown;
}

/**
 * Moving a branch, with what it costs on screen.
 *
 * Deliberately not drag and drop. A move rewrites every path below it, which
 * is the repository's directory layout and the scope of any permission
 * written against those categories; a gesture that can be made by accident is
 * the wrong way to ask for that. Choosing a parent and reading what will
 * happen takes a few seconds longer and is undoable by understanding it.
 */
export function MoveDialog({
  category,
  categories,
  onClose,
  onConfirm,
  busy,
  error,
}: MoveDialogProps) {
  const { t } = useTranslation();
  const [parentId, setParentId] = useState<string | null>(null);
  if (!category) return null;
  const counts = reach(categories, category);
  const parent = categories.find((c) => c.id === parentId) ?? null;
  const newPath = parent ? `${parent.path}/${category.slug}` : category.slug;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          setParentId(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('taxonomy.move_title', { name: category.name })}</DialogTitle>
          <DialogDescription>{t('taxonomy.move_intro')}</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-1 text-sm">
          <dt className="text-muted-foreground">{t('taxonomy.current_path')}</dt>
          <dd>
            <code className="text-xs break-all">{category.path}</code>
          </dd>
        </dl>
        <Field label={t('taxonomy.new_parent')}>
          <CategoryPicker
            categories={categories}
            value={parentId}
            onChange={setParentId}
            noneLabel={t('taxonomy.no_parent')}
            label={t('taxonomy.new_parent')}
            // Its own subtree would make the category its own ancestor.
            disabledIds={subtreeIds(categories, category)}
          />
        </Field>
        <dl className="grid gap-1 text-sm">
          <dt className="text-muted-foreground">{t('taxonomy.new_path')}</dt>
          <dd>
            <code className="text-xs break-all">{newPath}</code>
          </dd>
        </dl>
        {(counts.descendants > 0 || counts.items > 0) && (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            {t('taxonomy.move_effect', { categories: counts.descendants, items: counts.items })}
          </p>
        )}
        <ErrorNotice error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={busy || parentId === category.parent_id}
            onClick={() => onConfirm(parentId)}
          >
            {busy ? t('common.working') : t('taxonomy.move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface MergeDialogProps {
  category: CategorySummary | null;
  categories: readonly CategorySummary[];
  onClose: () => void;
  onConfirm: (intoId: string) => void;
  busy: boolean;
  error: unknown;
}

/**
 * Folding one category into another.
 *
 * The dialog says what moves and what happens to the name being closed,
 * because "merge" is the one word in this screen that sounds reversible and
 * is not: afterwards the closed category holds nothing and exists to say
 * where its contents went.
 */
export function MergeDialog({
  category,
  categories,
  onClose,
  onConfirm,
  busy,
  error,
}: MergeDialogProps) {
  const { t } = useTranslation();
  const [intoId, setIntoId] = useState<string | null>(null);
  if (!category) return null;
  const into = categories.find((c) => c.id === intoId) ?? null;
  const children = categories.filter((c) => c.parent_id === category.id).length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          setIntoId(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('taxonomy.merge_title')}</DialogTitle>
          <DialogDescription>{t('taxonomy.merge_intro')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <p className="font-medium">{category.name}</p>
          <ArrowDown aria-hidden="true" className="size-4 text-muted-foreground" />
          <Field label={t('taxonomy.merge_into')}>
            <CategoryPicker
              categories={categories}
              value={intoId}
              onChange={setIntoId}
              noneLabel={t('taxonomy.pick_category')}
              label={t('taxonomy.merge_into')}
              disabledIds={subtreeIds(categories, category)}
            />
          </Field>
        </div>
        {into && (
          <div className="grid gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p>
              {t('taxonomy.merge_effect', {
                items: category.item_count,
                categories: children,
                aliases: category.aliases.length,
              })}
            </p>
            <p className="text-muted-foreground">
              {t('taxonomy.merge_alias', { path: category.path })}
            </p>
          </div>
        )}
        <ErrorNotice error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={busy || intoId === null}
            onClick={() => onConfirm(intoId as string)}
          >
            {busy ? t('common.working') : t('taxonomy.merge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface DeleteDialogProps {
  category: CategorySummary | null;
  categories: readonly CategorySummary[];
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
  error: unknown;
}

/**
 * Removing a category that never meant anything.
 *
 * The dialog carries the whole argument, because "delete" on this screen means
 * something narrower than it does anywhere else: it is allowed only when nothing
 * has ever depended on the category, and for one that was used the answer is a
 * merge (ADR 0025).
 *
 * What the screen can already see — items filed here, categories under it — is
 * said before the click rather than discovered through a refusal. What it cannot
 * see, such as a policy rule scoped to the category, comes back from the server
 * and appears in the same place.
 */
export function DeleteDialog({
  category,
  categories,
  onClose,
  onConfirm,
  busy,
  error,
}: DeleteDialogProps) {
  const { t } = useTranslation();
  if (!category) return null;
  const children = categories.filter((c) => c.parent_id === category.id).length;
  const blocked = category.item_count > 0 || children > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('taxonomy.delete_title')}</DialogTitle>
          <DialogDescription>{t('taxonomy.delete_intro')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <p className="font-medium">{category.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{category.path}</p>
        </div>
        {blocked ? (
          <div className="grid gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p>
              {t('taxonomy.delete_blocked', { items: category.item_count, categories: children })}
            </p>
            <p className="text-muted-foreground">{t('taxonomy.delete_merge_instead')}</p>
          </div>
        ) : (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t('taxonomy.delete_effect')}
          </p>
        )}
        <ErrorNotice error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || blocked}
            onClick={onConfirm}
          >
            {busy ? t('common.working') : t('taxonomy.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
