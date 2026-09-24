import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { emptyDraft, listOf, type Draft } from './draft.ts';
import { ItemFields } from './ItemFields.tsx';

/** Writing an item by hand. Open from `?new`, so the address can link to it. */
export function NewItemSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const create = useMutation({
    mutationFn: () =>
      adminApi.knowledge.create({
        title: draft.title,
        body: draft.body,
        type: draft.type,
        categories: listOf(draft.categories),
        tags: listOf(draft.tags),
        sources: [],
        relations: [],
      }),
    onSuccess: async () => {
      setDraft(emptyDraft);
      onClose();
      await onCreated();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('knowledge.add')}</SheetTitle>
          <SheetDescription>{t('knowledge.add_intro')}</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="grid gap-4 p-4">
          <FieldSet disabled={create.isPending}>
            <ItemFields draft={draft} onChange={setDraft} rows={8} />
          </FieldSet>
          <ErrorNotice error={create.error} />
          <SheetFooter className="px-0">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || draft.title.trim() === ''}>
              {create.isPending ? t('common.working') : t('knowledge.add')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
