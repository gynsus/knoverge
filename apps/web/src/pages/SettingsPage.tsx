import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminApi } from '../api/admin.ts';
import { LanguageSwitcher } from '../components/LanguageSwitcher.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { useAuth } from '../auth/use-auth.ts';

const SESSIONS_KEY = ['account', 'sessions'] as const;

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const auth = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [changed, setChanged] = useState(false);

  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: ({ signal }) => adminApi.account.sessions(signal),
  });
  const revoke = useMutation({
    mutationFn: (sessionId: string) => adminApi.account.revokeSession(sessionId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });
  const changePassword = useMutation({
    mutationFn: () => adminApi.account.changePassword(current, next),
    onSuccess: async () => {
      setCurrent('');
      setNext('');
      setChanged(true);
      await client.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChanged(false);
    changePassword.mutate();
  };

  const me = auth.state.kind === 'authenticated' ? auth.state.me : null;

  return (
    <>
      <Card aria-labelledby="account-title">
        <CardHeader>
          <CardTitle id="account-title">{t('settings.account')}</CardTitle>
        </CardHeader>
        <CardContent>
          {me && (
            <p className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{me.user.display_name}</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{me.user.email}</code>
            </p>
          )}
          <Field
            label={t('language.label')}
            hint={t('settings.language_hint')}
            className="mb-6 max-w-md"
          >
            <LanguageSwitcher />
          </Field>
          <form onSubmit={submit} className="grid gap-4">
            <FieldGroup
              legend={t('settings.change_password')}
              disabled={changePassword.isPending}
              className="max-w-md"
            >
              <Field label={t('settings.current_password')}>
                <Input
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </Field>
              <Field label={t('settings.new_password')} hint={t('fields.password_hint')}>
                <Input
                  type="password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
              </Field>
            </FieldGroup>
            <ErrorNotice error={changePassword.error} />
            {changed && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('settings.password_changed')}
              </p>
            )}
            <Button
              type="submit"
              disabled={changePassword.isPending}
              className="justify-self-start"
            >
              {changePassword.isPending ? t('common.working') : t('settings.change_password')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card aria-labelledby="sessions-title">
        <CardHeader>
          <CardTitle id="sessions-title">{t('settings.sessions')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {sessions.isPending && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          )}
          {sessions.isError && <ErrorNotice error={sessions.error} />}
          {sessions.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('settings.started')}</TableHead>
                  <TableHead>{t('settings.client')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.data.sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell label={t('settings.started')}>
                      {new Date(session.created_at).toLocaleString(i18n.language)}
                    </TableCell>
                    <TableCell label={t('settings.client')}>
                      <span>{session.user_agent ?? t('settings.unknown_client')}</span>
                      {session.current && (
                        <Badge variant="outline" className="ml-2">
                          {t('settings.this_session')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell label={t('settings.revoke')}>
                      {!session.current && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => revoke.mutate(session.id)}
                          disabled={revoke.isPending}
                        >
                          {t('settings.revoke')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <ErrorNotice error={revoke.error} />
        </CardContent>
      </Card>
    </>
  );
}
