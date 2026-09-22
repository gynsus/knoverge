import { TERMS_VERSION } from '@knoverge/contracts';
import { Label } from 'radix-ui';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Steps } from '@/components/ui/steps';
import { Toast } from '@/components/ui/toast';
import { LanguageSwitcher } from '../components/LanguageSwitcher.tsx';
import { PasswordInput } from '../components/PasswordInput.tsx';
import { authApi } from '../api/auth.ts';
import { useAuth } from '../auth/use-auth.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

/** How many clauses the terms have. The catalogue carries the text of each. */
const TERMS_CLAUSES = 9;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * First run, in three steps.
 *
 * One page asking for everything at once reads as a form to be endured. Three
 * steps each ask one thing, and the terms get a step of their own rather than
 * a checkbox smuggled in beside a password field — somebody accepting them
 * should have nothing else to do at that moment.
 *
 * Nothing is sent until the last step. The steps are a way of asking, not a
 * sequence of commitments, so going back costs nothing and undoes nothing.
 */
export function SetupPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuth();
  const [step, setStep] = useState(0);
  const [accepted, setAccepted] = useState(false);
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
  const [notice, setNotice] = useState<{ message: string; tone: 'status' | 'error' } | null>(null);

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
    // Enter in a field advances a step rather than submitting half an
    // installation, which is what one form across three steps would do.
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.bootstrap({
        email: form.email,
        password: form.password,
        display_name: form.display_name,
        locale: (i18n.resolvedLanguage === 'ru' ? 'ru' : 'en') as 'en' | 'ru',
        workspace: { slug: form.workspace_slug, name: form.workspace_name },
        accepted_terms_version: TERMS_VERSION,
      });
      await auth.refresh();
      void navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const labels = [t('setup.step_terms'), t('setup.step_administrator'), t('setup.step_workspace')];
  const canContinue =
    step === 0
      ? accepted
      : step === 1
        ? form.display_name !== '' && form.email !== '' && form.password.length >= 12
        : form.workspace_name !== '' && form.workspace_slug !== '';

  return (
    <Card className="mx-auto w-full max-w-2xl" aria-labelledby="setup-title">
      <CardHeader className="gap-4">
        <div className="grid gap-1.5">
          <CardTitle id="setup-title">{t('setup.title')}</CardTitle>
          <CardDescription>{t('setup.intro')}</CardDescription>
        </div>
        <Steps labels={labels} current={step} />
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-6">
          {step === 0 && (
            <FieldGroup
              legend={t('setup.step_terms')}
              disabled={busy}
              className="rounded-lg border border-border p-4"
            >
              <Field label={t('setup.language')} hint={t('setup.language_hint')}>
                {/* The shell's switcher, so the list of languages lives in
                    one place and a third one appears here by being added
                    there. Full width rather than the header's compact size. */}
                <LanguageSwitcher className="h-9 w-full text-base md:text-sm" />
              </Field>

              <div className="grid gap-2">
                <h3 className="text-sm font-medium">
                  {t('terms.title')}{' '}
                  <span className="font-normal text-muted-foreground">
                    {t('terms.version', { version: TERMS_VERSION })}
                  </span>
                </h3>
                {/* Scrollable and focusable, so somebody reading with a
                    keyboard can reach it and page through it. */}
                <div
                  tabIndex={0}
                  className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm focus-visible:outline-ring focus-visible:outline-2"
                >
                  <p className="mb-3 text-muted-foreground">{t('terms.preamble')}</p>
                  <ol className="grid gap-3">
                    {Array.from({ length: TERMS_CLAUSES }, (_, index) => (
                      <li key={index} className="grid gap-0.5">
                        <strong className="font-medium">
                          {index + 1}. {t(`terms.clauses.${index + 1}.title`)}
                        </strong>
                        <span className="text-muted-foreground">
                          {t(`terms.clauses.${index + 1}.body`)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              <div className="flex items-start gap-2 text-sm">
                <Checkbox
                  id="accept-terms"
                  checked={accepted}
                  onCheckedChange={(value: boolean | 'indeterminate') =>
                    setAccepted(value === true)
                  }
                  className="mt-0.5"
                />
                <Label.Root htmlFor="accept-terms">{t('terms.accept')}</Label.Root>
              </div>
            </FieldGroup>
          )}

          {step === 1 && (
            <FieldGroup
              legend={t('setup.step_administrator')}
              disabled={busy}
              className="rounded-lg border border-border p-4"
            >
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
                <PasswordInput
                  value={form.password}
                  onChange={(password) => setForm((prev) => ({ ...prev, password }))}
                  onNotice={(message, tone) => setNotice({ message, tone })}
                  required
                  minLength={12}
                  autoComplete="new-password"
                  compact
                />
              </Field>
            </FieldGroup>
          )}

          {step === 2 && (
            <FieldGroup
              legend={t('setup.step_workspace')}
              disabled={busy}
              className="rounded-lg border border-border p-4"
            >
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
            </FieldGroup>
          )}

          <ErrorNotice error={error} />
          <div className="flex flex-wrap items-center gap-2">
            {step > 0 && (
              <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
                {t('common.back')}
              </Button>
            )}
            <Button type="submit" disabled={busy || !canContinue}>
              {busy ? t('common.working') : step < 2 ? t('common.next') : t('setup.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
      <Toast
        message={notice?.message ?? null}
        tone={notice?.tone ?? 'status'}
        onDismiss={() => setNotice(null)}
      />
    </Card>
  );
}
