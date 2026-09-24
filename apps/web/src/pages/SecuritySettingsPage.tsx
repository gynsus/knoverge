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
import { SESSIONS_KEY } from '@/lib/query-keys';
import { readUserAgent } from '@/lib/user-agent';
import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SettingsHeader } from '../components/settings/SettingsHeader.tsx';

/** The password, and everywhere the account is currently signed in. */
export function SecuritySettingsPage() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [changed, setChanged] = useState(false);

  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: ({ signal }) => adminApi.account.sessions(signal),
  });
  const revoke = useMutation({
    mutationFn: (sessionId: string) => adminApi.account.revokeSession(sessionId),
    onSuccess: () => client.invalidateQueries({ queryKey: SESSIONS_KEY }),
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

  return (
    <div className="grid gap-6">
      <SettingsHeader
        title={t('settings.sections.security.title')}
        intro={t('settings.sections.security.description')}
      />

      <Card aria-labelledby="password-title">
        <CardHeader>
          <CardTitle id="password-title">{t('settings.change_password')}</CardTitle>
        </CardHeader>
        <CardContent>
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
                  <TableHead>{t('settings.client')}</TableHead>
                  <TableHead>{t('settings.started')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.data.sessions.map((session) => {
                  const client_ = readUserAgent(session.user_agent);
                  return (
                    <TableRow key={session.id}>
                      <TableCell label={t('settings.client')}>
                        <span className="flex flex-wrap items-center gap-2">
                          <span>
                            {client_.browser ?? t('settings.unknown_client')}
                            {client_.platform ? ` · ${client_.platform}` : ''}
                          </span>
                          {session.current && (
                            <Badge variant="outline">{t('settings.this_session')}</Badge>
                          )}
                        </span>
                        {/* The raw string is the truth and not the answer, so
                            it is here and not first. */}
                        {session.user_agent && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              {t('common.more')}
                            </summary>
                            <code className="text-xs break-all text-muted-foreground">
                              {session.user_agent}
                            </code>
                          </details>
                        )}
                      </TableCell>
                      <TableCell label={t('settings.started')}>
                        {new Date(session.created_at).toLocaleString(i18n.language)}
                      </TableCell>
                      <TableCell label={t('settings.session_actions')}>
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
                  );
                })}
              </TableBody>
            </Table>
          )}
          <ErrorNotice error={revoke.error} />
        </CardContent>
      </Card>
    </div>
  );
}
