import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

const RULES_KEY = ['admin', 'policy', 'rules'] as const;

function subjectLabel(subject: Record<string, string>): string {
  const [key, value] = Object.entries(subject)[0] ?? ['', ''];
  return `${key}: ${value}`;
}

/**
 * Read and remove policy rules. Creating them from the browser arrives with the
 * review workflow, which is where the effects become visible.
 */
export function PolicyPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const rules = useQuery({
    queryKey: RULES_KEY,
    queryFn: ({ signal }) => adminApi.policy.rules(signal),
  });
  const remove = useMutation({
    mutationFn: (ruleId: string) => adminApi.policy.deleteRule(ruleId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: RULES_KEY });
    },
  });

  return (
    <section className="card" aria-labelledby="policy-title">
      <h2 id="policy-title">{t('policy.title')}</h2>
      <p>{t('policy.intro')}</p>
      {rules.isPending && <p role="status">{t('common.loading')}</p>}
      {rules.isError && <ErrorNotice error={rules.error} />}
      {rules.data?.rules.length === 0 && <p>{t('policy.empty')}</p>}
      {rules.data && rules.data.rules.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">{t('policy.priority')}</th>
              <th scope="col">{t('policy.subject')}</th>
              <th scope="col">{t('policy.action')}</th>
              <th scope="col">{t('policy.effect')}</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rules.data.rules.map((rule) => (
              <tr key={rule.id}>
                <td>{rule.priority}</td>
                <td>{subjectLabel(rule.subject as unknown as Record<string, string>)}</td>
                <td>
                  <code>{rule.action}</code>
                </td>
                <td>
                  {t(`policy.effects.${rule.effect}`)}
                  {!rule.enabled && <> ({t('policy.disabled')})</>}
                </td>
                <td>
                  <button type="button" onClick={() => remove.mutate(rule.id)}>
                    {t('policy.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorNotice error={remove.error} />
    </section>
  );
}
