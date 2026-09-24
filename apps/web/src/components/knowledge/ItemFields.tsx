import type { ItemType } from '@knoverge/contracts';
import { ItemType as ItemTypes } from '@knoverge/contracts';
import { useTranslation } from 'react-i18next';

import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { Draft } from './draft.ts';

/**
 * The fields of an item, shared by the form that creates one and the form that
 * changes one.
 *
 * They were two copies, which is how the two came to disagree: only one of
 * them offered tags.
 */
export function ItemFields({
  draft,
  onChange,
  rows,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** How tall the body box is: a new item starts smaller than an open one. */
  rows: number;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('knowledge.item_title')}>
        <Input
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
          required
          maxLength={300}
        />
      </Field>
      <Field label={t('knowledge.type')}>
        <Select
          value={draft.type}
          onChange={(e) => onChange({ ...draft, type: e.target.value as ItemType })}
        >
          {ItemTypes.options.map((type) => (
            <option key={type} value={type}>
              {t(`knowledge.types.${type}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('knowledge.categories')} hint={t('knowledge.categories_hint')}>
        <Input
          value={draft.categories}
          onChange={(e) => onChange({ ...draft, categories: e.target.value })}
        />
      </Field>
      <Field label={t('knowledge.tags')} hint={t('knowledge.tags_hint')}>
        <Input value={draft.tags} onChange={(e) => onChange({ ...draft, tags: e.target.value })} />
      </Field>
      <Field label={t('knowledge.body')} hint={t('knowledge.body_hint')}>
        <Textarea
          rows={rows}
          value={draft.body}
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
          required
        />
      </Field>
    </>
  );
}
