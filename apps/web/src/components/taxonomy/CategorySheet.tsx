import type { CategorySummary } from '@knoverge/contracts';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import type { CategoryDraft } from '@/lib/category-draft';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { CategoryPicker } from './CategoryPicker.tsx';

export interface CategorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The category being edited, or null when creating one. */
  editing: CategorySummary | null;
  initial: CategoryDraft;
  categories: readonly CategorySummary[];
  /** Ids the parent picker must refuse: the category itself and its subtree. */
  forbiddenParents: readonly string[];
  onSubmit: (draft: CategoryDraft) => void;
  busy: boolean;
  error: unknown;
}

/**
 * Creating and editing a category, over the page rather than beside it.
 *
 * The form used to be a card that took the bottom half of the screen whether
 * or not anybody was filling it in, which is half a screen not spent on the
 * tree — the thing the page is for. A sheet costs nothing until it is asked
 * for, and it is the same form either way: the fields a category has do not
 * depend on whether it exists yet.
 */
export function CategorySheet({
  open,
  onOpenChange,
  editing,
  initial,
  categories,
  forbiddenParents,
  onSubmit,
  busy,
  error,
}: CategorySheetProps) {
  const { t } = useTranslation();
  // Keyed on what is being edited rather than reset by an effect: the draft is
  // what somebody is typing, it has to survive a refetch behind the sheet, and
  // a remount is how React starts fresh without a render that undoes itself.
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {editing ? t('taxonomy.edit_category') : t('taxonomy.new_category')}
          </SheetTitle>
          <SheetDescription>
            {editing ? t('taxonomy.edit_intro') : t('taxonomy.new_intro')}
          </SheetDescription>
        </SheetHeader>
        <CategoryForm
          key={`${editing?.id ?? 'new'}:${String(open)}`}
          editing={editing}
          initial={initial}
          categories={categories}
          forbiddenParents={forbiddenParents}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
          busy={busy}
          error={error}
        />
      </SheetContent>
    </Sheet>
  );
}

function CategoryForm({
  editing,
  initial,
  categories,
  forbiddenParents,
  onSubmit,
  onCancel,
  busy,
  error,
}: Omit<CategorySheetProps, 'open' | 'onOpenChange'> & { onCancel: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const parent = categories.find((c) => c.id === draft.parentId) ?? null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(draft);
  };

  return (
    <form onSubmit={submit} className="grid gap-4 p-4">
      <FieldSet disabled={busy}>
        <Field label={t('taxonomy.name')}>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
            maxLength={120}
            autoFocus
          />
        </Field>
        {/* Only when editing: a new category's parent comes from where
                somebody asked for it, and its slug is derived from the name. */}
        {editing ? (
          <Field label={t('taxonomy.slug')} hint={t('taxonomy.slug_hint')}>
            <Input
              value={draft.slug}
              onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
              maxLength={64}
              pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
            />
          </Field>
        ) : (
          <Field label={t('taxonomy.parent')} hint={t('taxonomy.parent_hint')}>
            <CategoryPicker
              categories={categories}
              value={draft.parentId}
              onChange={(parentId) => setDraft({ ...draft, parentId })}
              noneLabel={t('taxonomy.no_parent')}
              label={t('taxonomy.parent')}
              disabledIds={forbiddenParents}
            />
          </Field>
        )}
        {!editing && (
          <p className="text-xs text-muted-foreground">
            {t('taxonomy.path_preview', {
              path: parent ? `${parent.path}/…` : '…',
            })}
          </p>
        )}
        <Field label={t('taxonomy.description')}>
          <Textarea
            rows={3}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            maxLength={2000}
          />
        </Field>
        <Field label={t('taxonomy.inclusion')} hint={t('taxonomy.guidance_hint')}>
          <Textarea
            rows={3}
            value={draft.inclusion}
            onChange={(e) => setDraft({ ...draft, inclusion: e.target.value })}
          />
        </Field>
        <Field label={t('taxonomy.exclusion')} hint={t('taxonomy.guidance_hint')}>
          <Textarea
            rows={3}
            value={draft.exclusion}
            onChange={(e) => setDraft({ ...draft, exclusion: e.target.value })}
          />
        </Field>
        <Field label={t('taxonomy.aliases')} hint={t('taxonomy.aliases_hint')}>
          <Input
            value={draft.aliases}
            onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
          />
        </Field>
      </FieldSet>
      <ErrorNotice error={error} />
      <SheetFooter className="px-0">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={busy || draft.name.trim() === ''}>
          {busy ? t('common.working') : editing ? t('taxonomy.save') : t('taxonomy.create')}
        </Button>
      </SheetFooter>
    </form>
  );
}
