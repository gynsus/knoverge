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
export type WizardPurpose = 'embedding' | 'generation' | 'vision' | 'transcription';

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
  const [name, setName] = useState(existing?.name ?? SUGGESTED_NAME.ollama);
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
      if (purpose === 'vision') {
        // A picture of a red square and one question about it. A catalogue says
        // which models exist, never which of them can see.
        setWrote(await adminApi.ai.testVision({ kind, base_url: baseUrl, model }));
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
  /**
   * Whether this purpose can be tried before it is saved.
   *
   * Everything else can: a phrase to embed, a sentence to write, a red square to
   * look at. A transcription model needs speech, and speech is the one thing
   * this product cannot make up — a synthesised clip would test the synthesiser.
   * So the wizard says what the test is instead of pretending to have run one.
   */
  const testable = purpose !== 'transcription';
  const outcome =
    purpose !== 'embedding'
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
                    const next = e.target.value as AiProviderKind;
                    // The name follows the kind while it is still the suggested
                    // one: a provider called Ollama that is not one is a row an
                    // operator will misread later.
                    if (name === SUGGESTED_NAME[kind]) setName(SUGGESTED_NAME[next]);
                    setKind(next);
                    setCatalogue(null);
                  }}
                >
                  <option value="ollama">{t('ai.kinds.ollama')}</option>
                  <option value="openai_compatible">{t('ai.kinds.openai_compatible')}</option>
                </Select>
              </Field>
              {/* Said here rather than in a field that does not exist: a key
                  cannot be typed in, and a server that needs one has to be
                  given it in the environment (ADR 0021). Most of the servers
                  people run at home need none. */}
              {kind === 'openai_compatible' && (
                <p className="text-sm text-muted-foreground">{t('ai.wizard.key_hint')}</p>
              )}
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
                  // A phrase rather than a number: "1 models" was wrong in English
                  // and Russian needs four forms where English needs two.
                  models: t('ai.n_models', { count: catalogue?.models.length ?? 0 }),
                })}
              />
              <Field label={t(MODEL_LABEL[purpose])} hint={t(MODEL_HINT[purpose])}>
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
                <p className="text-sm text-muted-foreground">{t(NO_MODELS[purpose])}</p>
              )}
              {testable ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!model || test.isPending}
                    onClick={() => test.mutate()}
                  >
                    {test.isPending && (
                      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                    )}
                    {t('ai.wizard.test_model')}
                  </Button>
                  {outcome && <Outcome ok={outcome.ok} text={outcome.text} />}
                </div>
              ) : (
                /* Said rather than left as a missing button, so that saving this
                   does not feel like skipping a step somebody else got. */
                <p className="text-sm text-muted-foreground">{t('ai.wizard.no_test')}</p>
              )}
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

/** What a provider of each kind is called before anybody renames it. */
const SUGGESTED_NAME: Record<AiProviderKind, string> = {
  ollama: 'Ollama',
  openai_compatible: 'OpenAI-compatible',
};

/** What the model field is called, and what it says underneath, per purpose. */
const MODEL_LABEL: Record<WizardPurpose, string> = {
  embedding: 'ai.wizard.model',
  generation: 'ai.wizard.model_generation',
  vision: 'ai.wizard.model_generation',
  transcription: 'ai.wizard.model_transcription',
};

const MODEL_HINT: Record<WizardPurpose, string> = {
  embedding: 'ai.wizard.model_hint',
  generation: 'ai.wizard.model_generation_hint',
  vision: 'ai.wizard.model_vision_hint',
  transcription: 'ai.wizard.model_transcription_hint',
};

const NO_MODELS: Record<WizardPurpose, string> = {
  embedding: 'ai.wizard.no_models',
  generation: 'ai.wizard.no_models_generation',
  vision: 'ai.wizard.no_models_generation',
  transcription: 'ai.wizard.no_models_transcription',
};

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
  // Nothing is filtered out for transcription. A model that listens is not a
  // model that writes, no catalogue has a word for what it is, and a filter
  // built on the two words that exist would hide every model that can do it.
  if (purpose === 'transcription') return [...models];
  // A model that looks at pictures is a model that writes, so the same
  // capability is what a catalogue reports for it. Which of those can actually
  // see is not something a list of names says — the test is what finds out.
  const wanted = purpose === 'embedding' ? 'embedding' : 'completion';
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
