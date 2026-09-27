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

/**
 * A count as a phrase, so the noun agrees with it.
 *
 * i18next pluralises one `count` per key, and these sentences count two or three
 * things at once: "Moves {{items}}, {{categories}} and {{aliases}}" cannot pluralise
 * any of them. So each countable noun is its own key with its own plural forms, and
 * the sentence takes the rendered phrase. English has two forms and Russian four,
 * and this is where both get used.
 */
function useCounted(): (noun: 'items' | 'categories' | 'aliases', count: number) => string {
  const { t } = useTranslation();
  return (noun, count) => t(`taxonomy.n_${noun}`, { count });
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
  const counted = useCounted();
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
            {t('taxonomy.move_effect', {
              categories: counted('categories', counts.descendants),
              items: counted('items', counts.items),
            })}
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
  const counted = useCounted();
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
                items: counted('items', category.item_count),
                categories: counted('categories', children),
                aliases: counted('aliases', category.aliases.length),
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
  const counted = useCounted();
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
              {t('taxonomy.delete_blocked', {
                items: counted('items', category.item_count),
                categories: counted('categories', children),
              })}
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

export interface ArchiveDialogProps {
  category: CategorySummary | null;
  categories: readonly CategorySummary[];
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
  error: unknown;
}

/**
 * Closing a category, and everything under it.
 *
 * Archiving takes the whole subtree out of the active tree in one write, which is
 * the part nobody could see: it was a menu item that acted on click and answered
 * with a toast, so a branch of nine sections closed as quietly as an empty one
 * (WEB_UI rule 4).
 *
 * Not `destructive`, and it says so: the knowledge stays where it is, the files do
 * not move, and Restore brings the branch back. What makes this worth a dialog is
 * the reach of one click, not the risk of losing anything.
 */
export function ArchiveDialog({
  category,
  categories,
  onClose,
  onConfirm,
  busy,
  error,
}: ArchiveDialogProps) {
  const { t } = useTranslation();
  const counted = useCounted();
  if (!category) return null;
  const inside = categories.filter(
    (c) => c.path.startsWith(`${category.path}/`) && c.status === 'active',
  );
  const items = inside.reduce((total, c) => total + c.item_count, category.item_count);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('taxonomy.archive_title')}</DialogTitle>
          <DialogDescription>{t('taxonomy.archive_intro')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <p className="font-medium">{category.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{category.path}</p>
        </div>
        <div className="grid gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p>
            {t('taxonomy.archive_effect', {
              categories: counted('categories', inside.length),
              items: counted('items', items),
            })}
          </p>
          <p className="text-muted-foreground">{t('taxonomy.archive_reversible')}</p>
        </div>
        <ErrorNotice error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={busy} onClick={onConfirm}>
            {busy ? t('common.working') : t('taxonomy.archive')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
