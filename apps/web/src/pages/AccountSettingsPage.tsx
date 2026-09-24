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
import { Field, FieldGroup } from '@/components/ui/field';
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
 * The address is shown rather than offered for editing. Changing it is a thing
 * somebody decides to do, and a form standing open for it makes every visit
 * look like the start of that decision.
 */
export function AccountSettingsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const auth = useAuth();
  const [changing, setChanging] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [changed, setChanged] = useState(false);

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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    changeEmail.mutate();
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
            <dd>{me?.user.display_name ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('fields.email')}</dt>
            <dd className="flex flex-wrap items-center gap-3">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {me?.user.email ?? '—'}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={() => setChanging(true)}>
                {t('common.change')}
              </Button>
            </dd>
          </dl>
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
        <CardContent>
          <Field
            label={t('language.label')}
            hint={t('settings.language_hint')}
            className="max-w-md"
          >
            <LanguageSwitcher />
          </Field>
        </CardContent>
      </Card>

      <Dialog open={changing} onOpenChange={(open) => !open && setChanging(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.change_email')}</DialogTitle>
            <DialogDescription>{t('settings.email_hint')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="grid gap-4">
            <FieldGroup legend={t('settings.change_email')} disabled={changeEmail.isPending}>
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
            </FieldGroup>
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
