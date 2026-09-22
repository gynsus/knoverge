import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { slugify } from '@/lib/slug';
import { adminApi } from '../api/admin.ts';
import { useAuth } from '../auth/use-auth.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

/**
 * A second workspace, and every one after it.
 *
 * A page rather than a dialog: it can be linked to, it survives a reload with
 * whatever was typed still on screen, and on a phone it is a page either way.
 *
 * Creating one moves you into it. Staying behind in the old workspace after
 * asking for a new one leaves somebody looking for a switcher to finish what
 * they started, and the first thing a new workspace needs is somebody in it.
 */
export function NewWorkspacePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuth();
  const workspaces = useWorkspaceContext();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState('en');

  const create = useMutation({
    mutationFn: () =>
      adminApi.workspace.create({
        slug,
        name,
        default_language: language,
        ...(description ? { description } : {}),
      }),
    onSuccess: async (result) => {
      // The membership is new, so the session's own view of itself is stale
      // until it is asked again. Selecting before that would name a workspace
      // this browser does not yet know it belongs to.
      await auth.refresh();
      workspaces.select(result.workspace.id);
      void navigate('/', { replace: true });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <Card aria-labelledby="new-workspace-title" className="grid max-w-2xl gap-3 p-4 sm:p-6">
      <CardTitle id="new-workspace-title">{t('workspace.create')}</CardTitle>
      <CardDescription>{t('workspace.create_intro')}</CardDescription>
      <form onSubmit={submit} className="grid gap-4">
        <FieldSet disabled={create.isPending}>
          <Field label={t('workspace.name')}>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              required
              maxLength={120}
              autoFocus
            />
          </Field>
          <Field label={t('fields.workspace_slug')} hint={t('fields.workspace_slug_hint')}>
            <Input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              required
              pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
            />
          </Field>
          <Field label={t('workspace.description')}>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </Field>
          <Field
            label={t('workspace.default_language')}
            hint={t('workspace.default_language_hint')}
          >
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">{t('language.en')}</option>
              <option value="ru">{t('language.ru')}</option>
            </Select>
          </Field>
        </FieldSet>
        <ErrorNotice error={create.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t('common.working') : t('workspace.create_submit')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void navigate('/workspaces')}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
