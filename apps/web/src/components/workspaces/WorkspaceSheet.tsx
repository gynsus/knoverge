import type { WorkspaceListEntry } from '@knoverge/contracts';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { slugify } from '@/lib/slug';
import type { WorkspaceDraft } from '@/lib/workspace-draft';
import { ErrorNotice } from '../ErrorNotice.tsx';

export interface WorkspaceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workspace being edited, or null when creating one. */
  editing: WorkspaceListEntry | null;
  initial: WorkspaceDraft;
  onSubmit: (draft: WorkspaceDraft) => void;
  busy: boolean;
  error: unknown;
}

/**
 * Making a workspace, and changing one, over the page rather than beside it.
 *
 * The same form either way: what a workspace is does not depend on whether it
 * exists yet. Only the identifier differs, because it is derived from the name
 * while there is no workspace and fixed once there is — the repository is
 * named after it and the paths in every file would move.
 */
export function WorkspaceSheet(props: WorkspaceSheetProps) {
  const { t } = useTranslation();
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {props.editing
              ? t('workspaces.edit_title', { name: props.editing.name })
              : t('workspace.create')}
          </SheetTitle>
          <SheetDescription>
            {props.editing ? t('workspaces.edit_intro') : t('workspace.create_intro')}
          </SheetDescription>
        </SheetHeader>
        {/* Keyed on what is being edited: the draft is what somebody is
            typing, and a remount is how React starts fresh without a render
            that undoes itself. */}
        <WorkspaceForm key={`${props.editing?.id ?? 'new'}:${String(props.open)}`} {...props} />
      </SheetContent>
    </Sheet>
  );
}

function WorkspaceForm({
  editing,
  initial,
  onSubmit,
  onOpenChange,
  busy,
  error,
}: WorkspaceSheetProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(draft);
  };

  return (
    <form onSubmit={submit} className="grid gap-4 p-4">
      <FieldSet disabled={busy}>
        <Field label={t('workspace.name')}>
          <Input
            value={draft.name}
            onChange={(e) => {
              const name = e.target.value;
              setDraft((current) => ({
                ...current,
                name,
                ...(editing || slugTouched ? {} : { slug: slugify(name) }),
              }));
            }}
            required
            maxLength={120}
            autoFocus
          />
        </Field>
        {editing ? (
          <p className="text-xs text-muted-foreground">
            {t('workspace.identifier')}: <code>{editing.slug}</code>
          </p>
        ) : (
          <Field label={t('fields.workspace_slug')} hint={t('fields.workspace_slug_hint')}>
            <Input
              value={draft.slug}
              onChange={(e) => {
                setDraft({ ...draft, slug: e.target.value });
                setSlugTouched(true);
              }}
              required
              pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
            />
          </Field>
        )}
        <Field label={t('workspace.description')}>
          <Textarea
            rows={3}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            maxLength={2000}
          />
        </Field>
        <Field label={t('workspace.default_language')} hint={t('workspace.default_language_hint')}>
          <Select
            value={draft.language}
            onChange={(e) => setDraft({ ...draft, language: e.target.value })}
          >
            <option value="en">{t('language.en')}</option>
            <option value="ru">{t('language.ru')}</option>
          </Select>
        </Field>
      </FieldSet>
      <ErrorNotice error={error} />
      <SheetFooter className="px-0">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={busy || draft.name.trim() === ''}>
          {busy
            ? t('common.working')
            : editing
              ? t('workspace.save')
              : t('workspace.create_submit')}
        </Button>
      </SheetFooter>
    </form>
  );
}
