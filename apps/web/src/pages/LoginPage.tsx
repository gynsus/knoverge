import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authApi } from '../api/auth.ts';
import { useAuth } from '../auth/use-auth.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await authApi.login({ email, password });
      auth.setMe(me);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      void navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto w-full max-w-md" aria-labelledby="login-title">
      <CardHeader>
        <CardTitle id="login-title">{t('login.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <FieldSet disabled={busy}>
            <Field label={t('fields.email')}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                autoFocus
              />
            </Field>
            <Field label={t('fields.password')}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
          </FieldSet>
          <ErrorNotice error={error} />
          <Button type="submit" disabled={busy} className="justify-self-start">
            {busy ? t('common.working') : t('login.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
