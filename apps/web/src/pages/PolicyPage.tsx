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
import { Label } from 'radix-ui';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { adminApi } from '../api/admin.ts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableActions,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

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
  const [params, setParams] = useSearchParams();
  const refresh = () => client.invalidateQueries({ queryKey: RULES_KEY });

  const remove = useMutation({
    mutationFn: (ruleId: string) => adminApi.policy.deleteRule(ruleId),
    onSuccess: refresh,
  });

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

  const editingId = params.get('edit');
  const editing = rules.data?.rules.find((r) => r.id === editingId) ?? null;
  const creating = params.has('new');
  const closeForm = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('edit');
    setParams(next, { replace: true });
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{t('policy.title')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('policy.intro')}</p>
        </div>
        <Button type="button" className="shrink-0" onClick={() => setParams({ new: '' })}>
          <Plus aria-hidden="true" className="size-4" />
          {t('policy.new_rule')}
        </Button>
      </div>

      <ErrorNotice error={rules.isError ? rules.error : undefined} />
      {rules.isPending && <p role="status">{t('common.loading')}</p>}
      {rules.data?.rules.length === 0 && (
        <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('policy.empty')}
        </div>
      )}
      <>
        {rules.data && rules.data.rules.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('policy.priority')}</TableHead>
                <TableHead>{t('policy.subject')}</TableHead>
                <TableHead>{t('policy.action')}</TableHead>
                <TableHead>{t('policy.effect')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('common.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.data.rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell label={t('policy.priority')}>{rule.priority}</TableCell>
                  <TableCell label={t('policy.subject')}>{describeSubject(rule.subject)}</TableCell>
                  <TableCell label={t('policy.action')}>
                    <code>{rule.action}</code>
                  </TableCell>
                  <TableCell label={t('policy.effect')}>
                    {t(`policy.effects.${rule.effect}`)}
                    {!rule.enabled && <> ({t('policy.disabled')})</>}
                  </TableCell>
                  <TableCell label={t('common.actions')}>
                    <TableActions>
                      <Button type="button" onClick={() => setParams({ edit: rule.id })}>
                        {t('policy.edit')}
                      </Button>
                      <Button
                        variant="destructive"
                        type="button"
                        onClick={() => remove.mutate(rule.id)}
                        disabled={remove.isPending}
                      >
                        {t('policy.delete')}
                      </Button>
                    </TableActions>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <ErrorNotice error={remove.error} />
      </>

      <Sheet open={creating || editing !== null} onOpenChange={(open) => !open && closeForm()}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{editing ? t('policy.edit_rule') : t('policy.new_rule')}</SheetTitle>
            <SheetDescription>{t('policy.form_intro')}</SheetDescription>
          </SheetHeader>
          <RuleForm
            key={editing?.id ?? 'new'}
            rule={editing}
            onDone={async () => {
              closeForm();
              await refresh();
            }}
            onCancel={closeForm}
          />
        </SheetContent>
      </Sheet>
    </div>
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
    <form onSubmit={submit} className="grid gap-4 p-4">
      <FieldSet disabled={save.isPending}>
        <Field label={t('policy.priority')} hint={t('policy.priority_hint')}>
          <Input
            type="number"
            min={0}
            max={10000}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            required
          />
        </Field>
        <Field label={t('policy.subject_kind')}>
          <Select
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
          </Select>
        </Field>
        {/* The value's label is the kind, so the two fields do not both
              read "Applies to". */}
        <Field
          label={t(`policy.subject_kinds.${kind}`)}
          {...(kind === 'actor_id' ? { hint: t('policy.actor_id_hint') } : {})}
        >
          {values ? (
            <Select value={value} onChange={(e) => setValue(e.target.value)}>
              {values.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input value={value} onChange={(e) => setValue(e.target.value)} required />
          )}
        </Field>
        <Field label={t('policy.action')}>
          <Select value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
            {PolicyActionName.options.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('policy.effect')} hint={t(`policy.effect_hints.${effect}`)}>
          <Select value={effect} onChange={(e) => setEffect(e.target.value as typeof effect)}>
            {PolicyEffect.options.map((e) => (
              <option key={e} value={e}>
                {t(`policy.effects.${e}`)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-2">
          <Checkbox
            id="rule-enabled"
            checked={enabled}
            onCheckedChange={(value: boolean | 'indeterminate') => setEnabled(value === true)}
          />
          <Label.Root htmlFor="rule-enabled" className="text-sm font-medium">
            {t('policy.enabled')}
          </Label.Root>
        </div>
      </FieldSet>
      <ErrorNotice error={save.error} />
      <SheetFooter className="px-0">
        <Button variant="outline" type="button" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.working') : rule ? t('policy.save') : t('policy.create')}
        </Button>
      </SheetFooter>
    </form>
  );
}
