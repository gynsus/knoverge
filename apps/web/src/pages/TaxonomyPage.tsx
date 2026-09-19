import type { CategorySummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Field } from '../components/Field.tsx';

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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  const categories = taxonomy.data?.categories ?? [];
  const parents = categories.filter((c) => c.status === 'active');

  return (
    <>
      <section className="card" aria-labelledby="taxonomy-title">
        <h2 id="taxonomy-title">{t('taxonomy.title')}</h2>
        <p>
          {t('taxonomy.intro')}{' '}
          {taxonomy.data && (
            <small>{t('taxonomy.version', { version: taxonomy.data.taxonomy_version })}</small>
          )}
        </p>
        {taxonomy.isPending && <p role="status">{t('common.loading')}</p>}
        {taxonomy.isError && <ErrorNotice error={taxonomy.error} />}
        {categories.length === 0 && taxonomy.isSuccess && <p>{t('taxonomy.empty')}</p>}
        <ul className="tree">
          {categories.map((category) => (
            <li key={category.id} data-depth={Math.min(category.path.split('/').length - 1, 6)}>
              <button
                type="button"
                className="link"
                onClick={(event) => {
                  lastTrigger.current = event.currentTarget;
                  setSelected(category);
                  setDraft(draftOf(category));
                }}
              >
                {category.name}
              </button>{' '}
              <code>{category.path}</code>
              {category.status !== 'active' && <> [{t(`taxonomy.statuses.${category.status}`)}]</>}
              {category.aliases.length > 0 && <> ({category.aliases.join(', ')})</>}
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <section className="card" aria-labelledby="category-detail-title">
          <h3 id="category-detail-title" tabIndex={-1} ref={detailHeading}>
            {selected.name}
          </h3>
          <Field label={t('taxonomy.rename')}>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
            />
          </Field>
          <Field label={t('taxonomy.slug')} hint={t('taxonomy.slug_hint')}>
            <input
              value={draft.slug}
              onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
              maxLength={64}
            />
          </Field>
          <Field label={t('taxonomy.description')}>
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={2000}
            />
          </Field>
          <Field label={t('taxonomy.inclusion')} hint={t('taxonomy.guidance_hint')}>
            <textarea
              rows={3}
              value={draft.inclusion}
              onChange={(e) => setDraft({ ...draft, inclusion: e.target.value })}
            />
          </Field>
          <Field label={t('taxonomy.exclusion')} hint={t('taxonomy.guidance_hint')}>
            <textarea
              rows={3}
              value={draft.exclusion}
              onChange={(e) => setDraft({ ...draft, exclusion: e.target.value })}
            />
          </Field>
          <Field label={t('taxonomy.aliases')} hint={t('taxonomy.aliases_hint')}>
            <input
              value={draft.aliases}
              onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
            />
          </Field>
          <Field label={t('taxonomy.move_to')} hint={t('taxonomy.parent_hint')}>
            <select
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
            </select>
          </Field>
          <p>
            <button type="button" onClick={() => save.mutate(selected)} disabled={save.isPending}>
              {t('taxonomy.save')}
            </button>{' '}
            <button
              type="button"
              onClick={() => archive.mutate(selected)}
              disabled={archive.isPending || selected.status === 'archived'}
            >
              {t('taxonomy.archive')}
            </button>{' '}
            <button type="button" onClick={() => setSelected(null)}>
              {t('common.close')}
            </button>
          </p>
          <ErrorNotice error={save.error ?? move.error ?? archive.error} />
        </section>
      )}

      <section className="card" aria-labelledby="new-category-title">
        <h3 id="new-category-title">{t('taxonomy.new')}</h3>
        <form onSubmit={submit}>
          <fieldset disabled={create.isPending}>
            <Field label={t('taxonomy.name')} hint={t('taxonomy.name_hint')}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('taxonomy.parent')}>
              <select value={parentPath} onChange={(e) => setParentPath(e.target.value)}>
                <option value="">{t('taxonomy.no_parent')}</option>
                {parents.map((category) => (
                  <option key={category.id} value={category.path}>
                    {category.path}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>
          <ErrorNotice error={create.error} />
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? t('common.working') : t('taxonomy.create')}
          </button>
        </form>
      </section>
    </>
  );
}
