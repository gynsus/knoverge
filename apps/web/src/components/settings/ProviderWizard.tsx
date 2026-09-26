import type {
  AiProviderKind,
  AiProviderSummary,
  CatalogueModel,
  CheckAiProviderResponse,
  TestAiGenerationResponse,
  TestAiModelResponse,
} from '@knoverge/contracts';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Steps } from '@/components/ui/steps';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/** What the wizard produces when somebody finishes it. */
export interface WizardResult {
  providerId?: string | undefined;
  kind: AiProviderKind;
  name: string;
  baseUrl: string;
  model: string;
}

/** Which job the model is being chosen for. */
export type WizardPurpose = 'embedding' | 'generation';

/**
 * Connecting a provider, in the order somebody actually does it.
 *
 * Nothing is saved until the last step. Both checks run against the address
 * that was typed rather than a stored row, because a form that can only test
 * what has already been saved teaches people to save things that do not work
 * (ADR 0021).
 *
 * The two checks are different questions and are asked separately. The first
 * is whether anything is there. The second is whether *this model* does the job
 * it is being chosen for, and it answers differently for each: for embeddings,
 * how many numbers are in one vector — the number the whole index hangs from,
 * which nobody configures; for generation, the sentence the model actually
 * wrote, because that is the only thing that shows it works.
 */
export function ProviderWizard({
  open,
  onOpenChange,
  existing,
  currentModel,
  purpose = 'embedding',
  onFinish,
  saving,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when an already configured provider is being changed. */
  existing?: AiProviderSummary | undefined;
  /** The model in use, so reopening the wizard starts where things are. */
  currentModel?: string | undefined;
  /** Which job the model is for. Decides what is offered and how it is tested. */
  purpose?: WizardPurpose;
  onFinish: (result: WizardResult) => void;
  saving: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<AiProviderKind>(existing?.kind ?? 'ollama');
  const [name, setName] = useState(existing?.name ?? 'Ollama');
  const [baseUrl, setBaseUrl] = useState(existing?.base_url ?? '');
  const [model, setModel] = useState(currentModel ?? '');
  const [catalogue, setCatalogue] = useState<CheckAiProviderResponse | null>(null);
  const [tested, setTested] = useState<TestAiModelResponse | null>(null);
  const [wrote, setWrote] = useState<TestAiGenerationResponse | null>(null);

  const check = useMutation({
    mutationFn: () => adminApi.ai.check({ kind, base_url: baseUrl }),
    onSuccess: (answer) => {
      setCatalogue(answer);
      if (answer.reachable) {
        // Pre-select when there is only one thing it could be: an operator
        // with one usable model should not have to choose it.
        const usable = modelsFor(purpose, answer.models);
        if (!model && usable.length === 1) setModel(usable[0]?.name ?? '');
        setStep(1);
      }
    },
  });

  const test = useMutation({
    mutationFn: async () => {
      if (purpose === 'generation') {
        setWrote(await adminApi.ai.testGeneration({ kind, base_url: baseUrl, model }));
        return;
      }
      setTested(await adminApi.ai.test({ kind, base_url: baseUrl, model }));
    },
  });

  const reset = (next: boolean) => {
    if (!next) {
      setStep(0);
      setCatalogue(null);
      setTested(null);
      setWrote(null);
      check.reset();
      test.reset();
    }
    onOpenChange(next);
  };

  const usable = modelsFor(purpose, catalogue?.models ?? []);
  const outcome =
    purpose === 'generation'
      ? wrote && {
          ok: wrote.ok,
          // What it said, not a tick. A model that answers in a hundred
          // milliseconds and says nothing useful is one to see before using.
          text: wrote.ok
            ? t('ai.wizard.model_wrote', { text: wrote.text ?? '', ms: wrote.latency_ms ?? 0 })
            : (wrote.error ?? t('ai.wizard.model_failed')),
        }
      : tested && {
          ok: tested.ok,
          text: tested.ok
            ? t('ai.wizard.model_works', {
                dimensions: tested.dimensions ?? 0,
                ms: tested.latency_ms ?? 0,
              })
            : (tested.error ?? t('ai.wizard.model_failed')),
        };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (step === 0) {
      check.mutate();
      return;
    }
    onFinish({ providerId: existing?.id, kind, name, baseUrl, model });
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {existing ? t('ai.wizard.title_change') : t('ai.wizard.title_connect')}
          </DialogTitle>
          <DialogDescription>{t('ai.wizard.intro')}</DialogDescription>
        </DialogHeader>

        <Steps
          labels={[t('ai.wizard.step_where'), t('ai.wizard.step_model')]}
          current={step}
          className="py-1"
        />

        <form onSubmit={submit} className="grid gap-4">
          {step === 0 ? (
            <FieldGroup legend={t('ai.wizard.step_where')} legendClassName="sm:sr-only">
              <Field label={t('ai.wizard.kind')} hint={t('ai.wizard.kind_hint')}>
                <Select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as AiProviderKind);
                    setCatalogue(null);
                  }}
                >
                  <option value="ollama">{t('ai.kinds.ollama')}</option>
                  {/* Visible and not selectable: a provider that needs an API
                      key needs somewhere to keep one, and there is nowhere
                      yet. Hiding it would read as "not supported". */}
                  <option value="openai_compatible" disabled>
                    {t('ai.kinds.openai_compatible_not_yet')}
                  </option>
                </Select>
              </Field>
              <Field label={t('ai.wizard.name')} hint={t('ai.wizard.name_hint')}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={64}
                />
              </Field>
              <Field label={t('ai.wizard.address')} hint={t('ai.wizard.address_hint')}>
                <Input
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    setCatalogue(null);
                  }}
                  required
                  type="url"
                  inputMode="url"
                  placeholder={t('ai.wizard.address_example')}
                />
              </Field>
              {catalogue && !catalogue.reachable && (
                <Outcome
                  ok={false}
                  // The provider's own words, which are the only thing that
                  // says whether this is the wrong port or the wrong machine.
                  text={catalogue.error ?? t('ai.wizard.unreachable')}
                />
              )}
              <ErrorNotice error={check.error} />
            </FieldGroup>
          ) : (
            <FieldGroup legend={t('ai.wizard.step_model')} legendClassName="sm:sr-only">
              <Outcome
                ok
                text={t('ai.wizard.reached', {
                  version: catalogue?.version ?? t('ai.wizard.no_version'),
                  count: catalogue?.models.length ?? 0,
                })}
              />
              <Field
                label={t(
                  purpose === 'generation' ? 'ai.wizard.model_generation' : 'ai.wizard.model',
                )}
                hint={t(
                  purpose === 'generation'
                    ? 'ai.wizard.model_generation_hint'
                    : 'ai.wizard.model_hint',
                )}
              >
                <Select
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setTested(null);
                    setWrote(null);
                  }}
                  required
                >
                  <option value="" disabled>
                    {t('ai.wizard.model_placeholder')}
                  </option>
                  {usable.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                      {entry.size ? ` · ${gigabytes(entry.size)}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              {usable.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t(
                    purpose === 'generation'
                      ? 'ai.wizard.no_models_generation'
                      : 'ai.wizard.no_models',
                  )}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!model || test.isPending}
                  onClick={() => test.mutate()}
                >
                  {test.isPending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
                  {t('ai.wizard.test_model')}
                </Button>
                {outcome && <Outcome ok={outcome.ok} text={outcome.text} />}
              </div>
              <ErrorNotice error={test.error} />
              <ErrorNotice error={error} />
            </FieldGroup>
          )}

          <DialogFooter>
            {step === 1 && (
              <Button type="button" variant="ghost" onClick={() => setStep(0)}>
                {t('ai.wizard.back')}
              </Button>
            )}
            <Button type="submit" disabled={check.isPending || saving || (step === 1 && !model)}>
              {(check.isPending || saving) && (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              )}
              {step === 0 ? t('ai.wizard.check') : t('ai.wizard.finish')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The models worth offering for a purpose.
 *
 * A provider that says what its models are for is taken at its word, and one
 * that says nothing offers everything: hiding every model from a server which
 * does not report capabilities would offer nothing at all.
 *
 * `completion` is what Ollama calls a model that writes. A model that reports
 * only `embedding` is excluded from generation and the other way round, because
 * offering one for the other job is offering a test that cannot pass.
 */
function modelsFor(purpose: WizardPurpose, models: readonly CatalogueModel[]): CatalogueModel[] {
  const wanted = purpose === 'generation' ? 'completion' : 'embedding';
  const declared = models.filter((model) => model.capabilities.length > 0);
  if (declared.length === 0) return [...models];
  return models.filter(
    (model) => model.capabilities.length === 0 || model.capabilities.includes(wanted),
  );
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** One line saying whether something worked, with the shape to match. */
function Outcome({ ok, text }: { ok: boolean; text: string }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <p
      role="status"
      className={`flex items-start gap-2 text-sm ${ok ? 'text-foreground' : 'text-destructive'}`}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}
