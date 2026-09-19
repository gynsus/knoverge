import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

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
    <section className="card" aria-labelledby="setup-title">
      <h2 id="setup-title">{t('setup.title')}</h2>
      <p>{t('setup.intro')}</p>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy}>
          <legend>{t('setup.administrator')}</legend>
          <label>
            {t('fields.display_name')}
            <input
              value={form.display_name}
              onChange={update('display_name')}
              required
              autoComplete="name"
            />
          </label>
          <label>
            {t('fields.email')}
            <input
              type="email"
              value={form.email}
              onChange={update('email')}
              required
              autoComplete="username"
            />
          </label>
          <label>
            {t('fields.password')}
            <input
              type="password"
              value={form.password}
              onChange={update('password')}
              required
              minLength={12}
              autoComplete="new-password"
              aria-describedby="password-hint"
            />
          </label>
          <small id="password-hint">{t('fields.password_hint')}</small>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>{t('setup.workspace')}</legend>
          <label>
            {t('fields.workspace_name')}
            <input value={form.workspace_name} onChange={update('workspace_name')} required />
          </label>
          <label>
            {t('fields.workspace_slug')}
            <input
              value={form.workspace_slug}
              onChange={update('workspace_slug')}
              required
              pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
              aria-describedby="slug-hint"
            />
          </label>
          <small id="slug-hint">{t('fields.workspace_slug_hint')}</small>
        </fieldset>
        <ErrorNotice error={error} />
        <button type="submit" disabled={busy}>
          {busy ? t('common.working') : t('setup.submit')}
        </button>
      </form>
    </section>
  );
}
