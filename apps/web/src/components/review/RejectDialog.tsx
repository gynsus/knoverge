import { useState, type FormEvent } from 'react';
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
import { Field, FieldSet } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ErrorNotice } from '../ErrorNotice.tsx';

/**
 * The reasons a proposal is usually turned down.
 *
 * Offered rather than required. They are the five sentences somebody would
 * otherwise type out, and picking one is faster than writing it — but a
 * rejection that does not fit them is exactly the one worth writing down, so
 * the text stays editable afterwards.
 */
const TEMPLATES = [
  'duplicate',
  'no_evidence',
  'wrong_category',
  'contradicts',
  'too_vague',
  'out_of_scope',
] as const;

/**
 * Rejecting, with a reason.
 *
 * A dialog rather than a button that acts: a rejection is the end of the
 * proposal, it is what the proposer reads back, and "rejected, no reason
 * given" teaches an agent nothing about what to do differently.
 */
export function RejectDialog({
  open,
  onOpenChange,
  onReject,
  busy,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReject: (reason: string) => void;
  busy: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState<string>('');
  const [reason, setReason] = useState('');

  const choose = (key: string) => {
    setTemplate(key);
    // Replaces the text rather than appending to it: the templates are whole
    // sentences, and two of them run together read as neither.
    setReason(key ? t(`review.reject_reasons.${key}`) : '');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onReject(reason.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('review.reject_title')}</DialogTitle>
          <DialogDescription>{t('review.reject_intro')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <FieldSet disabled={busy} className="max-w-none">
            <Field label={t('review.reject_reason')}>
              <Select value={template} onChange={(e) => choose(e.target.value)}>
                <option value="">{t('review.reject_reason_own')}</option>
                {TEMPLATES.map((key) => (
                  <option key={key} value={key}>
                    {t(`review.reject_reasons.${key}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('review.reject_note')} hint={t('review.reject_note_hint')}>
              <Textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={2000}
              />
            </Field>
          </FieldSet>
          <ErrorNotice error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? t('common.working') : t('review.reject')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
