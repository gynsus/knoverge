import {
  AiProviderId,
  type AiProviderKind,
  type AiProviderOrigin,
  type AiPurpose,
  type CatalogueModel,
} from '@knoverge/contracts';
import type {
  EmbeddingProvider,
  EmbeddingSource,
  GenerationProvider,
  GenerationSource,
} from '@knoverge/intelligence';

import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { AiAssignmentRecord, AiProviderRecord, AiRepository } from './repository.ts';

/** How an adapter builds a provider from what is stored. */
export type EmbeddingFactory = (spec: {
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
}) => EmbeddingProvider;

/** The same, for a model that writes rather than one that measures. */
export type GenerationFactory = (spec: {
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
}) => GenerationProvider;

/** How an adapter asks an address what it is and what it holds. */
export type CatalogueProbe = (spec: { kind: AiProviderKind; baseUrl: string }) => Promise<{
  version?: string;
  models: CatalogueModel[];
}>;

export interface AiSettingsServiceOptions {
  repository: AiRepository;
  /** Building a provider is the HTTP adapter's business, not the domain's. */
  embeddings: EmbeddingFactory;
  /**
   * Optional, so that an installation built before generation existed still
   * starts: with nothing here the generation purpose simply cannot be used,
   * which is the same answer as nothing assigned.
   */
  generation?: GenerationFactory;
  probe: CatalogueProbe;
  clock?: Clock;
}

/** What an operator sees on the settings page. */
export interface AiSettingsView {
  providers: AiProviderRecord[];
  assignments: AiAssignmentRecord[];
  embeddingsEnabled: boolean;
  generationEnabled: boolean;
}

export interface SaveProviderInput {
  providerId?: AiProviderId | undefined;
  kind: AiProviderKind;
  name: string;
  baseUrl: string;
  /** `environment` only for the seed on a first start. */
  origin?: AiProviderOrigin;
}

/** What a probe found, and why it failed when it did. */
export interface CheckOutcome {
  reachable: boolean;
  version: string | null;
  models: CatalogueModel[];
  error: string | null;
}

/** What one embedding of one short text cost and returned. */
export interface TestOutcome {
  ok: boolean;
  dimensions: number | null;
  latencyMs: number | null;
  error: string | null;
}

/** What one short generation cost and returned. */
export interface GenerationTestOutcome {
  ok: boolean;
  /**
   * What the model actually said, bounded.
   *
   * Shown, because a model that answers quickly and says nothing useful is a
   * model somebody should see before assigning it. A dimension is a number that
   * proves an embedding model works; for a generation model the only proof is
   * reading the answer.
   */
  text: string | null;
  latencyMs: number | null;
  error: string | null;
}

/** The phrase a model is tested with when the caller sends none. */
const TEST_TEXT = 'Knoverge is a knowledge ledger for humans and AI agents.';

/** What a test generation asks for: something short, checkable and dull. */
const TEST_INSTRUCTION =
  'Reply with one short sentence describing what the text says. Add nothing else.';

/** A ceiling for the test, so a model that will not stop does not hold the page. */
const TEST_MAX_TOKENS = 120;

/** How much of a test answer is worth carrying back to a form. */
const TEST_ANSWER_LIMIT = 500;

/**
 * AI providers, as configuration the product owns.
 *
 * Nothing here is required for the product to work (rule 9): with no provider
 * the answer to every question is "none", search is lexical and the settings
 * page says so.
 *
 * These changes are not ledger events. The ledger records what happened to
 * knowledge and to who may change it, keyed by a per-workspace sequence; a
 * provider belongs to the installation and has no workspace to be recorded in.
 * The server logs the change instead.
 */
export class AiSettingsService {
  private readonly o: AiSettingsServiceOptions;
  private readonly clock: Clock;
  /**
   * The provider in use, kept between calls.
   *
   * Not an optimisation. `EmbeddingProvider` learns its dimension from the
   * model's first answer, and a fresh instance per call would report zero
   * dimensions forever, which is how a profile fails to be recognised.
   */
  private cached: { key: string; provider: EmbeddingProvider } | null = null;

  constructor(options: AiSettingsServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async settings(): Promise<AiSettingsView> {
    const [providers, assignments] = await Promise.all([
      this.o.repository.providers(),
      this.o.repository.assignments(),
    ]);
    return {
      providers,
      assignments,
      embeddingsEnabled: assignments.some((a) => a.purpose === 'embedding'),
      // Both halves: a model assigned and an adapter able to build one. An
      // installation whose build has no generation factory would otherwise
      // report the feature as on and refuse every use of it.
      generationEnabled:
        this.o.generation !== undefined && assignments.some((a) => a.purpose === 'generation'),
    };
  }

  /** Create a provider, or replace what an existing one is. */
  async save(input: SaveProviderInput): Promise<AiProviderRecord> {
    const baseUrl = input.baseUrl.replace(/\/+$/u, '');
    const clash = await this.o.repository.findProviderByUrl(baseUrl);
    if (clash && clash.id !== input.providerId) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `a provider at ${baseUrl} is already configured as "${clash.name}"`,
        { objectIds: { provider_id: clash.id } },
      );
    }
    const now = this.clock.now();
    if (input.providerId) {
      const existing = await this.expect(input.providerId);
      // Anything changed here was changed by somebody, whatever the first
      // start read: the page has to be able to say where a setting came from.
      const patch = {
        kind: input.kind,
        name: input.name,
        baseUrl,
        origin: input.origin ?? ('interface' as const),
        updatedAt: now,
      };
      await this.o.repository.updateProvider(existing.id, patch);
      this.cached = null;
      return { ...existing, ...patch };
    }
    const record: AiProviderRecord = {
      // Parsed rather than cast: the brand says an id was checked, and this
      // is where it is.
      id: AiProviderId.parse(newId('aip')),
      kind: input.kind,
      name: input.name,
      baseUrl,
      origin: input.origin ?? 'interface',
      lastCheckedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.o.repository.insertProvider(record);
    return record;
  }

  async remove(providerId: AiProviderId): Promise<void> {
    await this.expect(providerId);
    // The assignments go with it, by the foreign key: an assignment pointing
    // at nothing reads as configured and embeds nothing.
    await this.o.repository.deleteProvider(providerId);
    this.cached = null;
  }

  /**
   * Ask an address what it is and what it holds.
   *
   * Takes a URL rather than a saved provider, so the wizard can test what was
   * typed before it is stored. When the address happens to be one already
   * configured, the outcome is recorded against it.
   */
  async check(spec: { kind: AiProviderKind; baseUrl: string }): Promise<CheckOutcome> {
    const baseUrl = spec.baseUrl.replace(/\/+$/u, '');
    let outcome: CheckOutcome;
    try {
      const catalogue = await this.o.probe({ kind: spec.kind, baseUrl });
      outcome = {
        reachable: true,
        version: catalogue.version ?? null,
        models: catalogue.models,
        error: null,
      };
    } catch (error) {
      outcome = { reachable: false, version: null, models: [], error: oneLine(error) };
    }
    const known = await this.o.repository.findProviderByUrl(baseUrl);
    if (known) {
      await this.o.repository.recordCheck(known.id, {
        lastCheckedAt: this.clock.now(),
        lastError: outcome.error,
      });
    }
    return outcome;
  }

  /** Put a model to work for a purpose. */
  async assign(input: {
    purpose: AiPurpose;
    providerId: AiProviderId;
    model: string;
  }): Promise<AiAssignmentRecord> {
    await this.expect(input.providerId);
    const record: AiAssignmentRecord = {
      purpose: input.purpose,
      providerId: input.providerId,
      model: input.model,
      updatedAt: this.clock.now(),
    };
    await this.o.repository.setAssignment(record);
    this.cached = null;
    return record;
  }

  /**
   * Stop using a provider for a purpose.
   *
   * The vectors already written stay: they are still answers from a model that
   * was asked, and deleting them would make reconnecting the same model a
   * rebuild of a workspace for no reason.
   */
  async unassign(purpose: AiPurpose): Promise<void> {
    await this.o.repository.removeAssignment(purpose);
    this.cached = null;
  }

  /**
   * One embedding of one short text, timed.
   *
   * Reports the dimension because it is the number the whole index hangs from
   * and nobody configures it. A model that is not an embedding model fails
   * here, which is the point of being able to run it before assigning.
   *
   * Takes an address rather than a saved provider, for the same reason `check`
   * does: the wizard tests what was typed, and saves what worked.
   */
  async test(input: {
    kind: AiProviderKind;
    baseUrl: string;
    model: string;
    text?: string | undefined;
  }): Promise<TestOutcome> {
    const started = this.clock.now().getTime();
    try {
      const embedder = this.o.embeddings({
        kind: input.kind,
        baseUrl: input.baseUrl.replace(/\/+$/u, ''),
        model: input.model,
      });
      const [vector] = await embedder.embed([input.text ?? TEST_TEXT]);
      const latencyMs = Math.max(0, this.clock.now().getTime() - started);
      if (!vector || vector.length === 0) {
        return { ok: false, dimensions: null, latencyMs, error: 'the model returned no numbers' };
      }
      return { ok: true, dimensions: vector.length, latencyMs, error: null };
    } catch (error) {
      return {
        ok: false,
        dimensions: null,
        latencyMs: Math.max(0, this.clock.now().getTime() - started),
        error: oneLine(error),
      };
    }
  }

  /**
   * One short generation, timed, with what the model said.
   *
   * Takes an address rather than a saved provider for the reason `check` and
   * `test` do: the wizard tests what was typed and saves what worked. A model
   * that is not a chat model fails here, which is the point of being able to run
   * it before assigning it to anything.
   */
  async testGeneration(input: {
    kind: AiProviderKind;
    baseUrl: string;
    model: string;
    text?: string | undefined;
  }): Promise<GenerationTestOutcome> {
    const started = this.clock.now().getTime();
    const since = () => Math.max(0, this.clock.now().getTime() - started);
    if (!this.o.generation) {
      return { ok: false, text: null, latencyMs: null, error: 'this build cannot generate text' };
    }
    try {
      const model = this.o.generation({
        kind: input.kind,
        baseUrl: input.baseUrl.replace(/\/+$/u, ''),
        model: input.model,
      });
      const answer = await model.generate({
        instruction: TEST_INSTRUCTION,
        input: input.text ?? TEST_TEXT,
        maxOutputTokens: TEST_MAX_TOKENS,
      });
      if (answer.text.trim() === '') {
        return { ok: false, text: null, latencyMs: since(), error: 'the model said nothing' };
      }
      return {
        ok: true,
        text: answer.text.slice(0, TEST_ANSWER_LIMIT),
        latencyMs: since(),
        error: null,
      };
    } catch (error) {
      return { ok: false, text: null, latencyMs: since(), error: oneLine(error) };
    }
  }

  /**
   * What generates now, or null when nothing does.
   *
   * Built fresh each time rather than cached, unlike the embedding one: a
   * generation provider learns nothing from its first answer, so there is no
   * state to lose and nothing to keep.
   */
  readonly generationSource: GenerationSource = async () => {
    if (!this.o.generation) return null;
    const assignment = await this.o.repository.assignment('generation');
    if (!assignment) return null;
    const provider = await this.o.repository.findProvider(assignment.providerId);
    if (!provider) return null;
    return this.o.generation({
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model: assignment.model,
    });
  };

  /**
   * What embeds now, or null when nothing does.
   *
   * Asked again on every use rather than held since start-up, because an
   * operator connects a provider, changes the model and disconnects it while
   * the product runs (ADR 0021).
   */
  readonly embeddingSource: EmbeddingSource = async () => {
    const assignment = await this.o.repository.assignment('embedding');
    if (!assignment) {
      this.cached = null;
      return null;
    }
    const provider = await this.o.repository.findProvider(assignment.providerId);
    if (!provider) return null;
    // Everything the answer depends on is in the key and nothing that does
    // not: a change of kind, of address or of model builds a new one, and a
    // provider that was only renamed keeps the dimension it learned.
    const key = [provider.kind, provider.baseUrl, assignment.model].join('|');
    if (this.cached?.key === key) return this.cached.provider;
    const built = this.o.embeddings({
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model: assignment.model,
    });
    this.cached = { key, provider: built };
    return built;
  };

  /**
   * Create the provider the environment describes, once.
   *
   * The variables provision a first start and are not read again (ADR 0021):
   * an installation that has been configured through the interface must not be
   * quietly reset by a compose file somebody forgot to update.
   */
  async seed(spec: { kind: AiProviderKind; baseUrl: string; model: string }): Promise<boolean> {
    const existing = await this.o.repository.providers();
    if (existing.length > 0) return false;
    const provider = await this.save({
      kind: spec.kind,
      name: spec.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible',
      baseUrl: spec.baseUrl,
      origin: 'environment',
    });
    await this.assign({ purpose: 'embedding', providerId: provider.id, model: spec.model });
    return true;
  }

  private async expect(providerId: AiProviderId): Promise<AiProviderRecord> {
    const provider = await this.o.repository.findProvider(providerId);
    if (!provider) {
      throw new DomainError('NOT_FOUND', 'no such provider', {
        objectIds: { provider_id: providerId },
      });
    }
    return provider;
  }
}

/**
 * An error as one line.
 *
 * Messages only, never a body or a cause chain: the provider is somebody
 * else's server and what it says back may quote a request.
 */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/gu, ' ').trim().slice(0, 500) || 'the provider could not be asked';
}
