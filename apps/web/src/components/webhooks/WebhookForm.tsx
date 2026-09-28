import type { EventType, WebhookSummary } from '@knoverge/contracts';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { generatePassword } from '@/lib/password';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { GROUPS, typesIn } from '../ledger/groups.ts';
import { isPlaintext } from './delivery.ts';

/** The shortest secret the contract takes, stated once and checked here too. */
const SECRET_MIN = 32;

/** What the generate button produces: comfortably past the minimum. */
const SECRET_LENGTH = 48;

/**
 * Adding an endpoint, or changing one.
 *
 * A drawer rather than a page, like every other object in this product, and the
 * same form for both: creating and changing a webhook ask the same questions,
 * and two forms would be two chances for them to drift apart.
 *
 * What it will not do is show the secret of an endpoint that already exists.
 * That is sealed and unreadable — so the choice on an existing webhook is to
 * leave it alone or replace it, and replacing it is said out loud, because a
 * receiver still checking the old one sees every delivery fail.
 */
export function WebhookForm({
  webhook,
  open,
  onOpenChange,
  onSaved,
}: {
  /** The endpoint being changed, or null when one is being added. */
  webhook: WebhookSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Told the secret this save established, or null when the endpoint kept the
   * one it already had.
   */
  onSaved: (secret: string | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [everything, setEverything] = useState((webhook?.event_types.length ?? 0) === 0);
  const [types, setTypes] = useState<Set<string>>(new Set(webhook?.event_types ?? []));
  const [status, setStatus] = useState<'active' | 'disabled'>(webhook?.status ?? 'active');
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState('');

  const save = useMutation({
    mutationFn: () =>
      adminApi.webhooks.save({
        ...(webhook ? { webhook_id: webhook.id } : {}),
        url: url.trim(),
        // Empty means every type, which is what the contract says and what the
        // "everything" choice above means. Sending the whole list instead would
        // silently stop delivering a type added in a later version.
        event_types: everything ? [] : ([...types] as EventType[]),
        status,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      }),
    // The server answers with a secret only when it made one. A secret the
    // operator brought is one this browser already has, and the receiver needs
    // it just as much — so either way the next screen can show it once.
    onSuccess: (answer) => onSaved(answer.secret ?? (secret.trim() || null)),
  });

  const trimmed = url.trim();
  const addressed = /^https?:\/\/.+/u.test(trimmed);
  const secretLongEnough = secret.trim() === '' || secret.trim().length >= SECRET_MIN;
  const nothingChosen = !everything && types.size === 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{webhook ? t('webhooks.edit_title') : t('webhooks.add_title')}</SheetTitle>
          <SheetDescription>{t('webhooks.form_intro')}</SheetDescription>
        </SheetHeader>

        <form
          onSubmit={submit}
          className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4"
        >
          <FieldSet disabled={save.isPending} className="max-w-none">
            <Field label={t('webhooks.url')} hint={t('webhooks.url_hint')}>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                maxLength={2048}
                autoFocus
                placeholder={t('webhooks.url_example')}
                inputMode="url"
              />
            </Field>
            {/* Said where it is decided, not after a save: what leaves is signed,
                and over http it is also readable by anything on the way. */}
            {addressed && isPlaintext(trimmed) && (
              <p className="text-sm text-muted-foreground">{t('webhooks.url_plaintext')}</p>
            )}

            <Field label={t('webhooks.events')} hint={t('webhooks.events_hint')}>
              <Select
                value={everything ? 'all' : 'some'}
                onChange={(e) => setEverything(e.target.value === 'all')}
              >
                <option value="all">{t('webhooks.events_all')}</option>
                <option value="some">{t('webhooks.events_some')}</option>
              </Select>
            </Field>
            {!everything && <EventPicker chosen={types} onChange={setTypes} />}

            <Field label={t('webhooks.status')} hint={t('webhooks.status_hint')}>
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}
              >
                <option value="active">{t('webhooks.statuses.active')}</option>
                <option value="disabled">{t('webhooks.statuses.disabled')}</option>
              </Select>
            </Field>

            {webhook === null ? (
              <Field label={t('webhooks.secret')} hint={t('webhooks.secret_hint')}>
                <Input
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  maxLength={200}
                  placeholder={t('webhooks.secret_generated')}
                />
              </Field>
            ) : (
              <div className="grid gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={replacing}
                    onCheckedChange={(next) => {
                      setReplacing(next === true);
                      if (next !== true) setSecret('');
                    }}
                  />
                  {t('webhooks.replace_secret')}
                </label>
                {replacing && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {t('webhooks.replace_secret_effect')}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label={t('webhooks.secret')}
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        maxLength={200}
                        className="min-w-0 flex-1"
                        placeholder={t('webhooks.secret_replacement')}
                      />
                      {/* Because a save with this box empty would keep the old
                          secret and say nothing, and because nobody should have
                          to invent thirty-two random characters. */}
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSecret(generatePassword(SECRET_LENGTH))}
                      >
                        {t('webhooks.generate_secret')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
            {!secretLongEnough && (
              <p role="alert" className="text-sm text-destructive">
                {t('webhooks.secret_too_short', { count: SECRET_MIN })}
              </p>
            )}
          </FieldSet>

          {/* A disabled button with no reason beside it is a dead end. Each of
              these is the same sentence the server would answer with, said
              before the press rather than after it (WEB_UI.md rule 2m). */}
          {url.trim() !== '' && !addressed && (
            <p className="text-sm text-muted-foreground">{t('webhooks.url_malformed')}</p>
          )}
          {nothingChosen && (
            <p className="text-sm text-muted-foreground">{t('webhooks.events_none_chosen')}</p>
          )}
          {replacing && secret.trim() === '' && (
            <p className="text-sm text-muted-foreground">{t('webhooks.replace_secret_needed')}</p>
          )}
          {webhook !== null && webhook.failures > 0 && (
            <p className="text-sm text-muted-foreground">{t('webhooks.save_retries')}</p>
          )}

          <ErrorNotice error={save.error} />

          <SheetFooter className="px-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending ||
                !addressed ||
                nothingChosen ||
                !secretLongEnough ||
                (replacing && secret.trim() === '')
              }
            >
              {save.isPending ? t('common.working') : t('webhooks.save')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Which events this endpoint is told about.
 *
 * Grouped the way the ledger screen groups them, and by the same function: a
 * second grouping would put `knowledge.proposed_create` with the knowledge here
 * and with the proposals there, and a reader would be right to trust neither.
 */
function EventPicker({
  chosen,
  onChange,
}: {
  chosen: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const groups = useMemo(
    () =>
      GROUPS.filter((group) => group !== 'all').map((group) => ({
        group,
        types: typesIn(group)
          .map((type) => ({ type, label: t(`events.types.${type}`) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      })),
    [t],
  );

  const toggle = (type: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(type);
    else next.delete(type);
    onChange(next);
  };

  return (
    <div className="grid max-h-72 gap-4 overflow-y-auto rounded-md border border-border p-3">
      {groups.map(({ group, types }) => {
        const all = types.every(({ type }) => chosen.has(type));
        const some = !all && types.some(({ type }) => chosen.has(type));
        return (
          <fieldset key={group} className="grid gap-2">
            <legend className="sr-only">{t(`ledger.groups.${group}`)}</legend>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                // Partly chosen is its own state. Drawn as unchecked, this box
                // would say the group is off while three of its types are on.
                checked={all ? true : some ? 'indeterminate' : false}
                onCheckedChange={(next) => {
                  const updated = new Set(chosen);
                  for (const { type } of types) {
                    if (next === true) updated.add(type);
                    else updated.delete(type);
                  }
                  onChange(updated);
                }}
              />
              {t(`ledger.groups.${group}`)}
            </label>
            <div className="grid gap-1.5 pl-6">
              {types.map(({ type, label }) => (
                <label key={type} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={chosen.has(type)}
                    onCheckedChange={(next) => toggle(type, next === true)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
