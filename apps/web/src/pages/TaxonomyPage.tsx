import type { CategorySummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Field } from '../components/Field.tsx';

const TAXONOMY_KEY = ['taxonomy'] as const;

export function TaxonomyPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [selected, setSelected] = useState<CategorySummary | null>(null);
  const [renameTo, setRenameTo] = useState('');
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
  const rename = useMutation({
    mutationFn: (category: CategorySummary) =>
      adminApi.taxonomy.update({ category_id: category.id, name: renameTo }),
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
                  setRenameTo(category.name);
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
            <input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} maxLength={120} />
          </Field>
          <p>
            <button
              type="button"
              onClick={() => rename.mutate(selected)}
              disabled={rename.isPending}
            >
              {t('taxonomy.save')}
            </button>{' '}
            <button
              type="button"
              onClick={() => move.mutate({ category: selected, parentId: null })}
              disabled={move.isPending || selected.parent_id === null}
            >
              {t('taxonomy.promote')}
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
          <ErrorNotice error={rename.error ?? move.error ?? archive.error} />
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
