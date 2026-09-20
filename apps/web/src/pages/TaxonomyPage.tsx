import type { CategorySummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

/**
 * One step of indentation per level of the tree.
 *
 * A fixed list rather than a computed class, because Tailwind only emits the
 * classes it can see in the source. Depth is capped: past six levels the
 * indentation costs more room than it explains, and the path is written beside
 * every entry anyway.
 */
const INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20', 'pl-24'] as const;

const depthOf = (path: string): number => Math.min(path.split('/').length - 1, INDENT.length - 1);

const TAXONOMY_KEY = ['taxonomy'] as const;

/** Everything a category carries that a person can edit. */
interface Draft {
  name: string;
  slug: string;
  description: string;
  inclusion: string;
  exclusion: string;
  aliases: string;
}

const emptyDraft: Draft = {
  name: '',
  slug: '',
  description: '',
  inclusion: '',
  exclusion: '',
  aliases: '',
};

function draftOf(category: CategorySummary): Draft {
  return {
    name: category.name,
    slug: category.slug,
    description: category.description ?? '',
    inclusion: category.inclusion_guidance.join('\n'),
    exclusion: category.exclusion_guidance.join('\n'),
    aliases: category.aliases.join(', '),
  };
}

/** One guidance line per line, blanks dropped. */
function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function splitCommas(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function TaxonomyPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [selected, setSelected] = useState<CategorySummary | null>(null);
  // Every editable field of a category, not only its name. Guidance and
  // aliases are what make a curated taxonomy useful, and neither was reachable.
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  // Archiving takes the whole subtree, so it asks first.
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);

  // The detail panel appears below the tree, so without moving focus a keyboard
  // or screen reader user is left where they were with nothing to tell them.
  useEffect(() => {
    if (selected) detailHeading.current?.focus();
    else lastTrigger.current?.focus();
  }, [selected]);

  const taxonomy = useQuery({
    queryKey: TAXONOMY_KEY,
    queryFn: ({ signal }) => adminApi.taxonomy.list(signal),
  });
  const refresh = () => client.invalidateQueries({ queryKey: TAXONOMY_KEY });

  const create = useMutation({
    mutationFn: () =>
      adminApi.taxonomy.create({ name, ...(parentPath ? { parent_path: parentPath } : {}) }),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  const save = useMutation({
    mutationFn: (category: CategorySummary) =>
      adminApi.taxonomy.update({
        category_id: category.id,
        name: draft.name,
        slug: draft.slug,
        description: draft.description || null,
        inclusion_guidance: splitLines(draft.inclusion),
        exclusion_guidance: splitLines(draft.exclusion),
        aliases: splitCommas(draft.aliases),
      }),
    onSuccess: async () => {
      setSelected(null);
      await refresh();
    },
  });
  const move = useMutation({
    mutationFn: ({ category, parentId }: { category: CategorySummary; parentId: string | null }) =>
      adminApi.taxonomy.move({
        category_id: category.id,
        new_parent_id: parentId as CategorySummary['parent_id'],
      }),
    onSuccess: async () => {
      setSelected(null);
      await refresh();
    },
  });
  const archive = useMutation({
    mutationFn: (category: CategorySummary) => adminApi.taxonomy.archive(category.id),
    onSuccess: async () => {
      setSelected(null);
      await refresh();
    },
  });
  const restore = useMutation({
    mutationFn: (category: CategorySummary) => adminApi.taxonomy.restore(category.id),
    onSuccess: async () => {
      setSelected(null);
      await refresh();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  const categories = taxonomy.data?.categories ?? [];
  const parents = categories.filter((c) => c.status === 'active');

  return (
    <>
      <Card aria-labelledby="taxonomy-title" className="grid gap-3 p-4 sm:p-6">
        <CardTitle id="taxonomy-title">{t('taxonomy.title')}</CardTitle>
        <p>
          {t('taxonomy.intro')}{' '}
          {taxonomy.data && (
            <small>{t('taxonomy.version', { version: taxonomy.data.taxonomy_version })}</small>
          )}
        </p>
        {taxonomy.isPending && <p role="status">{t('common.loading')}</p>}
        {taxonomy.isError && <ErrorNotice error={taxonomy.error} />}
        {categories.length === 0 && taxonomy.isSuccess && <p>{t('taxonomy.empty')}</p>}
        {/* The indentation is the hierarchy. It is a class rather than an
            inline style because the interface carries no inline styles, which
            is what lets the policy keep style-src to 'self'. */}
        <ul className="grid gap-1">
          {categories.map((category) => (
            <li
              key={category.id}
              className={cn('flex flex-wrap items-baseline gap-2', INDENT[depthOf(category.path)])}
            >
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-left"
                onClick={(event) => {
                  lastTrigger.current = event.currentTarget;
                  setSelected(category);
                  setDraft(draftOf(category));
                  setConfirmingArchive(false);
                }}
              >
                {category.name}
              </Button>
              <code className="text-xs text-muted-foreground">{category.path}</code>
              {category.status !== 'active' && (
                <Badge>{t(`taxonomy.statuses.${category.status}`)}</Badge>
              )}
              {category.aliases.length > 0 && (
                <small>
                  {t('taxonomy.aliases_inline', { aliases: category.aliases.join(', ') })}
                </small>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {selected && (
        <Card aria-labelledby="category-detail-title" className="grid gap-3 p-4 sm:p-6">
          <CardTitle id="category-detail-title" tabIndex={-1} ref={detailHeading}>
            {selected.name}
          </CardTitle>
          <Field label={t('taxonomy.rename')}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
            />
          </Field>
          <Field label={t('taxonomy.slug')} hint={t('taxonomy.slug_hint')}>
            <Input
              value={draft.slug}
              onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
              maxLength={64}
            />
          </Field>
          <Field label={t('taxonomy.description')}>
            <Textarea
              rows={3}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={2000}
            />
          </Field>
          <Field label={t('taxonomy.inclusion')} hint={t('taxonomy.guidance_hint')}>
            <Textarea
              rows={3}
              value={draft.inclusion}
              onChange={(e) => setDraft({ ...draft, inclusion: e.target.value })}
            />
          </Field>
          <Field label={t('taxonomy.exclusion')} hint={t('taxonomy.guidance_hint')}>
            <Textarea
              rows={3}
              value={draft.exclusion}
              onChange={(e) => setDraft({ ...draft, exclusion: e.target.value })}
            />
          </Field>
          <Field label={t('taxonomy.aliases')} hint={t('taxonomy.aliases_hint')}>
            <Input
              value={draft.aliases}
              onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
            />
          </Field>
          <Field label={t('taxonomy.move_to')} hint={t('taxonomy.parent_hint')}>
            <Select
              value={selected.parent_id ?? ''}
              onChange={(e) =>
                move.mutate({ category: selected, parentId: e.target.value || null })
              }
              disabled={move.isPending}
            >
              <option value="">{t('taxonomy.no_parent')}</option>
              {categories
                // A category cannot move into its own subtree, and the server
                // refuses it, so it is not offered.
                .filter((c) => c.id !== selected.id && !c.path.startsWith(`${selected.path}/`))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.path}
                  </option>
                ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => save.mutate(selected)} disabled={save.isPending}>
              {t('taxonomy.save')}
            </Button>
            {selected.status === 'archived' ? (
              <Button
                type="button"
                onClick={() => restore.mutate(selected)}
                disabled={restore.isPending}
              >
                {t('taxonomy.restore')}
              </Button>
            ) : confirmingArchive ? (
              <>
                <span className="self-center text-sm">{t('taxonomy.confirm_archive')}</span>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => archive.mutate(selected)}
                  disabled={archive.isPending}
                >
                  {t('taxonomy.confirm')}
                </Button>
                <Button type="button" onClick={() => setConfirmingArchive(false)}>
                  {t('common.cancel')}
                </Button>
              </>
            ) : (
              <Button type="button" onClick={() => setConfirmingArchive(true)}>
                {t('taxonomy.archive')}
              </Button>
            )}
            <Button type="button" onClick={() => setSelected(null)}>
              {t('common.close')}
            </Button>
          </div>
          <ErrorNotice error={save.error ?? move.error ?? archive.error ?? restore.error} />
        </Card>
      )}

      <Card aria-labelledby="new-category-title" className="grid gap-3 p-4 sm:p-6">
        <CardTitle id="new-category-title">{t('taxonomy.new')}</CardTitle>
        <form onSubmit={submit} className="grid gap-4">
          <FieldSet disabled={create.isPending}>
            <Field label={t('taxonomy.name')} hint={t('taxonomy.name_hint')}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('taxonomy.parent')}>
              <Select value={parentPath} onChange={(e) => setParentPath(e.target.value)}>
                <option value="">{t('taxonomy.no_parent')}</option>
                {parents.map((category) => (
                  <option key={category.id} value={category.path}>
                    {category.path}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldSet>
          <ErrorNotice error={create.error} />
          <Button type="submit" disabled={create.isPending} className="justify-self-start">
            {create.isPending ? t('common.working') : t('taxonomy.create')}
          </Button>
        </form>
      </Card>
    </>
  );
}
