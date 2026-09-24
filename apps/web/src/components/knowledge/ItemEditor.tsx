import type { KnowledgeItemDetail } from '@knoverge/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { changed, draftOf, listOf, type Draft } from './draft.ts';
import { ItemFields } from './ItemFields.tsx';

/**
 * Changing one item.
 *
 * Keyed on the item id by its caller, so the draft starts from the item it was
 * given. Synchronising it from an effect instead is the pattern that renders
 * twice and is wrong on the first pass.
 *
 * An edit carries the revision and the hash it was based on, so two people
 * editing one item ends in a conflict the second is told about rather than in
 * the first one's work disappearing.
 */
export function ItemEditor({
  item,
  truncated,
  mayWrite,
  onChanged,
  onCancel,
}: {
  item: KnowledgeItemDetail;
  /** Whether the body is only part of what the item holds. */
  truncated: boolean;
  mayWrite: boolean;
  onChanged: () => Promise<void>;
  /** Leaves edit mode. Told whether there is unsaved work. */
  onCancel: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const initial = draftOf(item);
  const [draft, setDraft] = useState<Draft>(initial);
  const dirty = changed(draft, initial);

  const save = useMutation({
    mutationFn: () =>
      adminApi.knowledge.update({
        item_id: item.id,
        base_revision_id: item.current_revision_id,
        base_content_hash: item.content_hash,
        title: draft.title,
        body: draft.body,
        type: draft.type,
        categories: listOf(draft.categories),
        tags: listOf(draft.tags),
      }),
    onSuccess: onChanged,
  });

  return (
    <div className="grid content-start gap-3 p-4 sm:p-6">
      {truncated && <p role="alert">{t('knowledge.truncated')}</p>}
      <FieldSet disabled={!mayWrite || truncated || save.isPending}>
        <ItemFields draft={draft} onChange={setDraft} rows={16} />
      </FieldSet>
      <ErrorNotice error={save.error} />
      {/* Cancel and Save, and nothing else. Delete used to sit here, one
          button away from the one somebody presses without looking. */}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onCancel(dirty)}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty || truncated}
        >
          {save.isPending ? t('common.working') : t('knowledge.save')}
        </Button>
      </div>
    </div>
  );
}
