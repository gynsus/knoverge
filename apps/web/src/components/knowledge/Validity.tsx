import type { KnowledgeItemDetail } from '@knoverge/contracts';
import { useTranslation } from 'react-i18next';

import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { Draft } from './draft.ts';
import { hasLapsed, validityShape } from './validity.ts';

/**
 * When a claim holds.
 *
 * Three dates and no cleverness. They are how a reader knows a fact is about
 * last year, and since ADR 0022 they are also how a person resolves a
 * contradiction between two claims that were both true at different times —
 * which was impossible from the browser until this existed.
 */
export function ValidityFields({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  const { t } = useTranslation();
  const backwards =
    draft.validFrom !== '' && draft.validUntil !== '' && draft.validUntil < draft.validFrom;
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('knowledge.valid_from')} hint={t('knowledge.valid_from_hint')}>
          <Input
            type="date"
            value={draft.validFrom}
            onChange={(e) => onChange({ ...draft, validFrom: e.target.value })}
          />
        </Field>
        <Field label={t('knowledge.valid_until')} hint={t('knowledge.valid_until_hint')}>
          <Input
            type="date"
            value={draft.validUntil}
            onChange={(e) => onChange({ ...draft, validUntil: e.target.value })}
            aria-invalid={backwards || undefined}
          />
        </Field>
      </div>
      {/* Said before the request rather than after it: the server refuses this
          too, and a person should not have to press Save to find out. */}
      {backwards && (
        <p role="alert" className="text-sm text-destructive">
          {t('knowledge.period_backwards')}
        </p>
      )}
      <Field label={t('knowledge.observed_at')} hint={t('knowledge.observed_at_hint')}>
        <Input
          type="date"
          value={draft.observedAt}
          onChange={(e) => onChange({ ...draft, observedAt: e.target.value })}
        />
      </Field>
    </div>
  );
}

/**
 * The period a claim holds for, in a sentence.
 *
 * Stated even when it is open at both ends, because "always" is an answer and a
 * blank row is not. A period that has passed says so: the item is still active
 * and still true of the period it names, and a reader who cannot tell the
 * difference has been given last year's answer as this year's.
 */
export function Validity({
  item,
}: {
  item: Pick<KnowledgeItemDetail, 'valid_from' | 'valid_until'>;
}) {
  const { t, i18n } = useTranslation();
  const on = (instant: string) => new Date(instant).toLocaleDateString(i18n.language);
  const shape = validityShape(item);
  const said =
    shape.kind === 'always'
      ? t('knowledge.holds_always')
      : shape.kind === 'since'
        ? t('knowledge.holds_since', { from: on(shape.from) })
        : shape.kind === 'until'
          ? t('knowledge.holds_until', { until: on(shape.until) })
          : t('knowledge.holds_between', { from: on(shape.from), until: on(shape.until) });
  return (
    <>
      <span>{said}</span>
      {hasLapsed(item) && (
        <span className="ml-1.5 text-muted-foreground">{t('knowledge.holds_lapsed')}</span>
      )}
    </>
  );
}
