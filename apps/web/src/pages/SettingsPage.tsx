import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Field } from '../components/Field.tsx';
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
      <section className="card" aria-labelledby="account-title">
        <h2 id="account-title">{t('settings.account')}</h2>
        {me && (
          <p>
            {me.user.display_name} <code>{me.user.email}</code>
          </p>
        )}
        <form onSubmit={submit}>
          <fieldset disabled={changePassword.isPending}>
            <legend>{t('settings.change_password')}</legend>
            <Field label={t('settings.current_password')}>
              <input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
            <Field label={t('settings.new_password')} hint={t('fields.password_hint')}>
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
              />
            </Field>
          </fieldset>
          <ErrorNotice error={changePassword.error} />
          {changed && <p role="status">{t('settings.password_changed')}</p>}
          <button type="submit" disabled={changePassword.isPending}>
            {changePassword.isPending ? t('common.working') : t('settings.change_password')}
          </button>
        </form>
      </section>

      <section className="card" aria-labelledby="sessions-title">
        <h2 id="sessions-title">{t('settings.sessions')}</h2>
        {sessions.isPending && <p role="status">{t('common.loading')}</p>}
        {sessions.isError && <ErrorNotice error={sessions.error} />}
        {sessions.data && (
          <table>
            <thead>
              <tr>
                <th scope="col">{t('settings.started')}</th>
                <th scope="col">{t('settings.client')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {sessions.data.sessions.map((session) => (
                <tr key={session.id}>
                  <td>{new Date(session.created_at).toLocaleString(i18n.language)}</td>
                  <td>
                    <span>{session.user_agent ?? t('settings.unknown_client')}</span>
                    {session.current && <> {t('settings.this_session')}</>}
                  </td>
                  <td>
                    {!session.current && (
                      <button
                        type="button"
                        onClick={() => revoke.mutate(session.id)}
                        disabled={revoke.isPending}
                      >
                        {t('settings.revoke')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ErrorNotice error={revoke.error} />
      </section>
    </>
  );
}
