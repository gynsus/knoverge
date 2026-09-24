import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SESSIONS_KEY } from '@/lib/query-keys';
import { adminApi } from '../api/admin.ts';
import { useAuth } from '../auth/use-auth.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { LanguageSwitcher } from '../components/LanguageSwitcher.tsx';
import { SettingsHeader } from '../components/settings/SettingsHeader.tsx';

/**
 * Who the person is: their name, their address, the language they read in.
 *
 * Neither is offered as a form standing open. Changing one is a thing somebody
 * decides to do, and a form waiting for it makes every visit look like the
 * start of that decision.
 *
 * The two are not asked for in the same way, because they are not the same
 * kind of change. The address is what the account signs in with, so it takes
 * the password and a dialog. A name is a label: it changes in place, and the
 * only thing that undoes it is typing the old one back.
 */
export function AccountSettingsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const auth = useAuth();
  const [changing, setChanging] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [changed, setChanged] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [renamed, setRenamed] = useState(false);

  const changeEmail = useMutation({
    mutationFn: () => adminApi.account.changeEmail(password, email),
    onSuccess: async () => {
      setEmail('');
      setPassword('');
      setChanging(false);
      setChanged(true);
      // The address is on the account, and every other session was opened
      // against the old one.
      await auth.refresh();
      await client.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });

  const changeName = useMutation({
    mutationFn: () => adminApi.account.changeDisplayName(name.trim()),
    onSuccess: async () => {
      setRenaming(false);
      setRenamed(true);
      // The name is in the shell and in the workspace switcher, so the account
      // has to be read again for the rest of the page to agree with this one.
      await auth.refresh();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    changeEmail.mutate();
  };

  const submitName = (event: FormEvent) => {
    event.preventDefault();
    setRenamed(false);
    changeName.mutate();
  };

  const me = auth.state.kind === 'authenticated' ? auth.state.me : null;

  return (
    <div className="grid gap-6">
      <SettingsHeader
        title={t('settings.sections.account.title')}
        intro={t('settings.sections.account.description')}
      />

      <Card aria-labelledby="identity-title">
        <CardHeader>
          <CardTitle id="identity-title">{t('settings.identity')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">{t('fields.display_name')}</dt>
            <dd>
              {renaming ? (
                <form onSubmit={submitName} className="grid max-w-md gap-2">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label={t('fields.display_name')}
                    required
                    maxLength={120}
                    autoComplete="name"
                    autoFocus
                    disabled={changeName.isPending}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={changeName.isPending}>
                      {changeName.isPending ? t('common.working') : t('workspace.save')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setRenaming(false)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                  <ErrorNotice error={changeName.error} />
                </form>
              ) : (
                <span className="flex flex-wrap items-center gap-3">
                  <span>{me?.user.display_name ?? '—'}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setName(me?.user.display_name ?? '');
                      setRenamed(false);
                      changeName.reset();
                      setRenaming(true);
                    }}
                    // Two buttons reading "Change" one above the other are
                    // the same word twice to anyone who hears them rather
                    // than sees which row they are on.
                    aria-label={t('settings.change_name')}
                  >
                    {t('common.change')}
                  </Button>
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">{t('fields.email')}</dt>
            <dd className="flex flex-wrap items-center gap-3">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {me?.user.email ?? '—'}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setChanging(true)}
                aria-label={t('settings.change_email')}
              >
                {t('common.change')}
              </Button>
            </dd>
          </dl>
          {renamed && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('settings.name_changed')}
            </p>
          )}
          {changed && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('settings.email_changed')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card aria-labelledby="language-title">
        <CardHeader>
          <CardTitle id="language-title">{t('language.label')}</CardTitle>
        </CardHeader>
        <CardContent className="grid max-w-md gap-1.5">
          {/* No label: the card is titled "Language" and a field labelled
              the same directly under it is the same word twice (rule 2g).
              The control keeps the name, for anyone not reading the card. */}
          <LanguageSwitcher className="h-9 w-full text-base md:text-sm" />
          <p className="text-xs text-muted-foreground">{t('settings.language_hint')}</p>
        </CardContent>
      </Card>

      <Dialog open={changing} onOpenChange={(open) => !open && setChanging(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.change_email')}</DialogTitle>
            <DialogDescription>{t('settings.email_hint')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="grid gap-4">
            <FieldSet disabled={changeEmail.isPending}>
              <Field label={t('settings.new_email')}>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </Field>
              {/* Named differently from the one in the password form: two
                  fields labelled "Current password" are indistinguishable to
                  anyone reading them out. */}
              <Field label={t('settings.your_password')}>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </Field>
            </FieldSet>
            <ErrorNotice error={changeEmail.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setChanging(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={changeEmail.isPending}>
                {changeEmail.isPending ? t('common.working') : t('settings.change_email')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
