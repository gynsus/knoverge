import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authApi } from '../api/auth.ts';
import { useAuth } from '../auth/use-auth.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function SetupPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuth();
  const [form, setForm] = useState({
    display_name: '',
    email: '',
    password: '',
    workspace_name: '',
    workspace_slug: '',
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const update = (field: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setForm((prev) => ({
      ...prev,
      [field]: value,
      ...(field === 'workspace_name' && !slugTouched ? { workspace_slug: slugify(value) } : {}),
    }));
    if (field === 'workspace_slug') setSlugTouched(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.bootstrap({
        email: form.email,
        password: form.password,
        display_name: form.display_name,
        locale: (i18n.resolvedLanguage === 'ru' ? 'ru' : 'en') as 'en' | 'ru',
        workspace: { slug: form.workspace_slug, name: form.workspace_name },
      });
      await auth.refresh();
      void navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto w-full max-w-2xl" aria-labelledby="setup-title">
      <CardHeader>
        <CardTitle id="setup-title">{t('setup.title')}</CardTitle>
        <CardDescription>{t('setup.intro')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-6">
          <fieldset disabled={busy} className="grid gap-4 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">{t('setup.administrator')}</legend>
            <Field label={t('fields.display_name')}>
              <Input
                value={form.display_name}
                onChange={update('display_name')}
                required
                autoComplete="name"
              />
            </Field>
            <Field label={t('fields.email')}>
              <Input
                type="email"
                value={form.email}
                onChange={update('email')}
                required
                autoComplete="username"
              />
            </Field>
            <Field label={t('fields.password')} hint={t('fields.password_hint')}>
              <Input
                type="password"
                value={form.password}
                onChange={update('password')}
                required
                minLength={12}
                autoComplete="new-password"
              />
            </Field>
          </fieldset>
          <fieldset disabled={busy} className="grid gap-4 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">{t('setup.workspace')}</legend>
            <Field label={t('fields.workspace_name')}>
              <Input value={form.workspace_name} onChange={update('workspace_name')} required />
            </Field>
            <Field label={t('fields.workspace_slug')} hint={t('fields.workspace_slug_hint')}>
              <Input
                value={form.workspace_slug}
                onChange={update('workspace_slug')}
                required
                pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
              />
            </Field>
          </fieldset>
          <ErrorNotice error={error} />
          <Button type="submit" disabled={busy} className="justify-self-start">
            {busy ? t('common.working') : t('setup.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
