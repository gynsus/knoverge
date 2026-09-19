import {
  ActorType,
  PolicyActionName,
  PolicyEffect,
  TrustTier,
  type PolicyRuleSummary,
  type PolicySubject,
  type UpsertPolicyRuleRequest,
} from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Field } from '../components/Field.tsx';

const RULES_KEY = ['admin', 'policy', 'rules'] as const;

/** Which kind of subject a rule applies to. */
type SubjectKind = 'trust_tier' | 'actor_type' | 'actor_id';

function subjectKind(subject: PolicySubject): SubjectKind {
  if ('trust_tier' in subject) return 'trust_tier';
  if ('actor_type' in subject) return 'actor_type';
  return 'actor_id';
}

function subjectValue(subject: PolicySubject): string {
  return Object.values(subject)[0] ?? '';
}

/**
 * Policy rules decide whether a permitted write happens directly or waits for a
 * reviewer. Without an explicit allow_direct rule every agent write waits, so
 * this page is how an installation ever lets one through.
 */
export function PolicyPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const rules = useQuery({
    queryKey: RULES_KEY,
    queryFn: ({ signal }) => adminApi.policy.rules(signal),
  });
  const refresh = () => client.invalidateQueries({ queryKey: RULES_KEY });

  const remove = useMutation({
    mutationFn: (ruleId: string) => adminApi.policy.deleteRule(ruleId),
    onSuccess: refresh,
  });
  const [editing, setEditing] = useState<PolicyRuleSummary | null>(null);

  /** Reads a subject the way a person describes it, not the way it is stored. */
  const describeSubject = (subject: PolicySubject): string => {
    const kind = subjectKind(subject);
    const value = subjectValue(subject);
    const readable =
      kind === 'trust_tier'
        ? t(`agents.tiers.${value}`)
        : kind === 'actor_type'
          ? t(`policy.actor_types.${value}`)
          : value;
    return t('policy.subject_is', { kind: t(`policy.subject_kinds.${kind}`), value: readable });
  };

  return (
    <>
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
                  <td>{describeSubject(rule.subject)}</td>
                  <td>
                    <code>{rule.action}</code>
                  </td>
                  <td>
                    {t(`policy.effects.${rule.effect}`)}
                    {!rule.enabled && <> ({t('policy.disabled')})</>}
                  </td>
                  <td>
                    <button type="button" onClick={() => setEditing(rule)}>
                      {t('policy.edit')}
                    </button>{' '}
                    <button
                      type="button"
                      onClick={() => remove.mutate(rule.id)}
                      disabled={remove.isPending}
                    >
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

      <RuleForm
        key={editing?.id ?? 'new'}
        rule={editing}
        onDone={async () => {
          setEditing(null);
          await refresh();
        }}
        onCancel={() => setEditing(null)}
      />
    </>
  );
}

function RuleForm({
  rule,
  onDone,
  onCancel,
}: {
  rule: PolicyRuleSummary | null;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [kind, setKind] = useState<SubjectKind>(rule ? subjectKind(rule.subject) : 'trust_tier');
  const [value, setValue] = useState(rule ? subjectValue(rule.subject) : 'trusted');
  const [action, setAction] = useState(rule?.action ?? 'knowledge.update');
  const [effect, setEffect] = useState(rule?.effect ?? 'require_review');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);

  const save = useMutation({
    mutationFn: () =>
      adminApi.policy.upsertRule({
        ...(rule ? { rule_id: rule.id as UpsertPolicyRuleRequest['rule_id'] } : {}),
        priority: Number(priority),
        subject: { [kind]: value } as PolicySubject,
        action,
        effect,
        enabled,
      }),
    onSuccess: onDone,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  // The value a subject takes depends on its kind: a tier and an actor type are
  // fixed sets, an actor id is typed in.
  const values =
    kind === 'trust_tier'
      ? TrustTier.options.map((v) => ({ value: v, label: t(`agents.tiers.${v}`) }))
      : kind === 'actor_type'
        ? ActorType.options.map((v) => ({ value: v, label: t(`policy.actor_types.${v}`) }))
        : null;

  return (
    <section className="card" aria-labelledby="rule-form-title">
      <h3 id="rule-form-title">{rule ? t('policy.edit_rule') : t('policy.new_rule')}</h3>
      <p>{t('policy.form_intro')}</p>
      <form onSubmit={submit}>
        <fieldset disabled={save.isPending}>
          <Field label={t('policy.priority')} hint={t('policy.priority_hint')}>
            <input
              type="number"
              min={0}
              max={10000}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              required
            />
          </Field>
          <Field label={t('policy.subject_kind')}>
            <select
              value={kind}
              onChange={(e) => {
                const next = e.target.value as SubjectKind;
                setKind(next);
                setValue(next === 'trust_tier' ? 'trusted' : next === 'actor_type' ? 'agent' : '');
              }}
            >
              {(['trust_tier', 'actor_type', 'actor_id'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`policy.subject_kinds.${k}`)}
                </option>
              ))}
            </select>
          </Field>
          {/* The value's label is the kind, so the two fields do not both
              read "Applies to". */}
          <Field
            label={t(`policy.subject_kinds.${kind}`)}
            {...(kind === 'actor_id' ? { hint: t('policy.actor_id_hint') } : {})}
          >
            {values ? (
              <select value={value} onChange={(e) => setValue(e.target.value)}>
                {values.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            ) : (
              <input value={value} onChange={(e) => setValue(e.target.value)} required />
            )}
          </Field>
          <Field label={t('policy.action')}>
            <select value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
              {PolicyActionName.options.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('policy.effect')} hint={t(`policy.effect_hints.${effect}`)}>
            <select value={effect} onChange={(e) => setEffect(e.target.value as typeof effect)}>
              {PolicyEffect.options.map((e) => (
                <option key={e} value={e}>
                  {t(`policy.effects.${e}`)}
                </option>
              ))}
            </select>
          </Field>
          <p className="field">
            <label>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />{' '}
              {t('policy.enabled')}
            </label>
          </p>
        </fieldset>
        <ErrorNotice error={save.error} />
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.working') : rule ? t('policy.save') : t('policy.create')}
        </button>{' '}
        {rule && (
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
      </form>
    </section>
  );
}
