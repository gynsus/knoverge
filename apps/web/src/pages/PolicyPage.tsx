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
import { useMemo, useState, type FormEvent } from 'react';
import { Label } from 'radix-ui';
import { MoreHorizontal, Plus, Scale, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { adminApi } from '../api/admin.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  const [query, setQuery] = useState('');
  const [effect, setEffect] = useState<'all' | PolicyEffect>('all');
  const [state, setState] = useState<'all' | 'enabled' | 'disabled'>('all');
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

  const all = useMemo(() => rules.data?.rules ?? [], [rules.data]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      all
        .filter(
          (rule) =>
            (needle === '' ||
              rule.action.toLowerCase().includes(needle) ||
              subjectValue(rule.subject).toLowerCase().includes(needle)) &&
            (effect === 'all' || rule.effect === effect) &&
            (state === 'all' || (state === 'enabled') === rule.enabled),
        )
        // Priority order, always. Which rule wins is decided by going down this
        // list until one matches, so any other order would show a sequence that
        // is not the one the server walks. That is also why there is no sort
        // control here, unlike the lists that have no order of their own.
        .sort((a, b) => a.priority - b.priority || a.action.localeCompare(b.action))
    );
  }, [all, query, effect, state]);

  const filtered = query !== '' || effect !== 'all' || state !== 'all';
  const reset = () => {
    setQuery('');
    setEffect('all');
    setState('all');
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

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1 lg:max-w-md">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('policy.search')}
            placeholder={t('policy.search')}
            className="pr-9 pl-9"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('policy.search_clear')}
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:flex">
          <Select
            value={effect}
            onChange={(e) => setEffect(e.target.value as 'all' | PolicyEffect)}
            aria-label={t('policy.filter_effect')}
            className="sm:w-48"
          >
            <option value="all">{t('policy.all_effects')}</option>
            {PolicyEffect.options.map((value) => (
              <option key={value} value={value}>
                {t(`policy.effects.${value}`)}
              </option>
            ))}
          </Select>
          <Select
            value={state}
            onChange={(e) => setState(e.target.value as 'all' | 'enabled' | 'disabled')}
            aria-label={t('policy.filter_state')}
            className="sm:w-52"
          >
            <option value="all">{t('policy.all_states')}</option>
            <option value="enabled">{t('policy.state_enabled')}</option>
            <option value="disabled">{t('policy.state_disabled')}</option>
          </Select>
        </div>
      </div>

      <ErrorNotice error={rules.isError ? rules.error : undefined} />
      <ErrorNotice error={remove.error} />
      {rules.isPending && <p role="status">{t('common.loading')}</p>}

      {rules.data && (
        <>
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {/* Announced, because the number changes as somebody types and
                  nothing else would say the list had shrunk. */}
              <p role="status" className="text-sm text-muted-foreground">
                {t('policy.count', { count: visible.length })}
              </p>
              {/* The order is the rule, not a preference: which one wins is
                  decided by walking this list. */}
              {visible.length > 1 && (
                <p className="text-xs text-muted-foreground">{t('policy.order_note')}</p>
              )}
            </div>
            {filtered && visible.length > 0 && (
              <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
                {t('policy.reset_filters')}
              </Button>
            )}
          </div>

          {visible.length > 0 ? (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((rule) => (
                <li key={rule.id} className="grid">
                  <RuleCard
                    rule={rule}
                    subject={describeSubject(rule.subject)}
                    onEdit={() => setParams({ edit: rule.id })}
                    onDelete={() => remove.mutate(rule.id)}
                    deleting={remove.isPending}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              filtered={filtered}
              onReset={reset}
              onCreate={() => setParams({ new: '' })}
            />
          )}
        </>
      )}

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

/**
 * One rule, as a card.
 *
 * The subject is the title because it is what somebody scans for: "which rule
 * covers this agent" is the question, and the action and the decision are the
 * answer to it.
 *
 * Deleting is in the menu rather than beside the card as a red button. A rule
 * is removed rarely and read often, and a destructive control standing next to
 * every row is pressed by accident eventually.
 */
function RuleCard({
  rule,
  subject,
  onEdit,
  onDelete,
  deleting,
}: {
  rule: PolicyRuleSummary;
  subject: string;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card className="group relative grid grid-rows-[auto_1fr] transition-colors focus-within:ring-2 focus-within:ring-ring hover:border-foreground/20">
      <CardHeader className="gap-3 pb-4">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="min-w-0 text-base leading-6 break-words">
            {/* One real link's worth of behaviour: a button stretched over the
                card, so the whole card opens the rule rather than only the
                words. A div with onClick does not exist to a keyboard. */}
            <button
              type="button"
              onClick={onEdit}
              className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            >
              {subject}
            </button>
          </CardTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* Above the stretched button, or the card's own click wins. */}
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('policy.actions', { subject })}
                className="relative z-10 -mt-1 -mr-1 shrink-0 px-2"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>{t('policy.edit')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={deleting}
                onSelect={onDelete}
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              >
                {t('policy.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="grid content-end gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-normal">
            {t('policy.priority_is', { priority: rule.priority })}
          </Badge>
          {/* The decision is what the rule is for, so it is the one badge
              that carries colour. */}
          <Badge variant={rule.effect === 'deny' ? 'destructive' : 'default'}>
            {t(`policy.effects.${rule.effect}`)}
          </Badge>
          {!rule.enabled && (
            <Badge variant="outline" className="text-muted-foreground">
              {t('policy.disabled')}
            </Badge>
          )}
        </div>
        <p className="border-t border-border pt-4 text-sm">
          <span className="text-muted-foreground">{t('policy.action')}: </span>
          <code className="break-all">{rule.action}</code>
        </p>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  filtered,
  onReset,
  onCreate,
}: {
  filtered: boolean;
  onReset: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-72 place-items-center gap-4 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-lg bg-muted">
        <Scale className="size-5 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="grid gap-1">
        <h3 className="font-medium">{filtered ? t('policy.empty_filtered') : t('policy.empty')}</h3>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {filtered ? t('policy.empty_filtered_hint') : t('policy.empty_hint')}
        </p>
      </div>
      {filtered ? (
        <Button variant="outline" onClick={onReset}>
          {t('policy.reset_filters')}
        </Button>
      ) : (
        <Button onClick={onCreate}>
          <Plus className="size-4" aria-hidden="true" />
          {t('policy.new_rule')}
        </Button>
      )}
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
