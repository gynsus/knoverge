import type { AiProviderId } from '@knoverge/contracts';
import type { EmbeddingProvider, GenerationProvider } from '@knoverge/intelligence';
import { describe, expect, it, vi } from 'vitest';

import {
  AiSettingsService,
  DomainError,
  type AiAssignmentRecord,
  type AiProviderRecord,
  type AiRepository,
} from '../src/index.ts';

/** The repository as a map, because this is about the service's decisions. */
function repository(): AiRepository {
  const providers = new Map<string, AiProviderRecord>();
  const assignments = new Map<string, AiAssignmentRecord>();
  return {
    providers: async () => [...providers.values()],
    findProvider: async (id) => providers.get(id) ?? null,
    findProviderByUrl: async (url) =>
      [...providers.values()].find((p) => p.baseUrl === url) ?? null,
    insertProvider: async (record) => void providers.set(record.id, record),
    updateProvider: async (id, patch) => {
      const existing = providers.get(id);
      if (existing) providers.set(id, { ...existing, ...patch });
    },
    recordCheck: async (id, outcome) => {
      const existing = providers.get(id);
      if (existing) providers.set(id, { ...existing, ...outcome });
    },
    deleteProvider: async (id) => {
      providers.delete(id);
      for (const [purpose, a] of assignments) if (a.providerId === id) assignments.delete(purpose);
    },
    assignments: async () => [...assignments.values()],
    assignment: async (purpose) => assignments.get(purpose) ?? null,
    setAssignment: async (record) => void assignments.set(record.purpose, record),
    removeAssignment: async (purpose) => void assignments.delete(purpose),
  };
}

function embedder(dimensions: number, fail?: string): EmbeddingProvider {
  let learned = 0;
  return {
    get profile() {
      return { provider: 'ollama', model: 'bge-m3', dimensions: learned };
    },
    embed: async (texts) => {
      if (fail) throw new Error(fail);
      learned = dimensions;
      return texts.map(() => Array.from({ length: dimensions }, () => 0.1));
    },
  };
}

/** A model that writes, or one that refuses to. */
function writer(text: string, fail?: string): GenerationProvider {
  return {
    profile: { provider: 'ollama', model: 'qwen3' },
    generate: async () => {
      if (fail) throw new Error(fail);
      return { text, usage: { inputTokens: 10, outputTokens: 4 }, truncated: false };
    },
  };
}

function build2(
  repo: AiRepository,
  embeddings: (spec: { kind: string; baseUrl: string; model: string }) => EmbeddingProvider,
) {
  return build({ repository: repo, embeddings });
}

function service(options: Partial<Parameters<typeof build>[0]> = {}) {
  return build({ repository: repository(), ...options });
}

function build(options: {
  repository: AiRepository;
  embeddings?: (spec: { kind: string; baseUrl: string; model: string }) => EmbeddingProvider;
  probe?: () => Promise<{ version?: string; models: { name: string; capabilities: string[] }[] }>;
  /** Absent on purpose in some tests: a build that cannot generate text. */
  generation?: (spec: { kind: string; baseUrl: string; model: string }) => GenerationProvider;
}) {
  return new AiSettingsService({
    repository: options.repository,
    embeddings: options.embeddings ?? (() => embedder(1024)),
    ...(options.generation ? { generation: options.generation as never } : {}),
    probe: options.probe ?? (async () => ({ version: '0.32.13', models: [] })),
  });
}

describe('with nothing configured', () => {
  it('embeds nothing, which is what rule 9 asks for', async () => {
    const ai = service();
    expect(await ai.embeddingSource()).toBeNull();
    const view = await ai.settings();
    expect(view).toMatchObject({
      providers: [],
      assignments: [],
      embeddingsEnabled: false,
      generationEnabled: false,
    });
  });

  it('generates nothing either', async () => {
    const ai = service({ generation: () => writer('anything') });
    expect(await ai.generationSource()).toBeNull();
  });
});

describe('a model that writes', () => {
  /** A provider with a generation model already doing the job. */
  async function assigned(options: Parameters<typeof service>[0] = {}) {
    const ai = service(options);
    const provider = await ai.save({
      kind: 'ollama',
      name: 'Ollama',
      baseUrl: 'http://ollama:11434',
    });
    await ai.assign({ purpose: 'generation', providerId: provider.id, model: 'qwen3' });
    return { ai, provider };
  }

  it('is reported as on only when a build can talk to one', async () => {
    // Both halves have to hold. Saying the feature is on where it cannot run
    // makes every use of it a surprise.
    const withFactory = await assigned({ generation: () => writer('ok') });
    expect((await withFactory.ai.settings()).generationEnabled).toBe(true);

    const without = await assigned();
    expect((await without.ai.settings()).generationEnabled).toBe(false);
    expect(await without.ai.generationSource()).toBeNull();
  });

  it('is built from what is assigned, and asked again every time', async () => {
    // An operator changes the model while the product runs (ADR 0021), so a
    // provider held since start-up would be the wrong one.
    const built: string[] = [];
    const { ai, provider } = await assigned({
      generation: (spec) => {
        built.push(spec.model);
        return writer('ok');
      },
    });
    expect(await ai.generationSource()).not.toBeNull();
    await ai.assign({ purpose: 'generation', providerId: provider.id, model: 'llama3' });
    expect(await ai.generationSource()).not.toBeNull();
    expect(built).toEqual(['qwen3', 'llama3']);
  });

  it('stops being available when it is unassigned', async () => {
    const { ai } = await assigned({ generation: () => writer('ok') });
    await ai.unassign('generation');
    expect(await ai.generationSource()).toBeNull();
    expect((await ai.settings()).generationEnabled).toBe(false);
  });

  it('is gone when the provider it named is deleted', async () => {
    const { ai, provider } = await assigned({ generation: () => writer('ok') });
    await ai.remove(provider.id);
    expect(await ai.generationSource()).toBeNull();
  });

  it('leaves the embedding model alone', async () => {
    // Two purposes, two assignments: choosing what writes must not disturb
    // what measures.
    const ai = service({ generation: () => writer('ok') });
    const provider = await ai.save({
      kind: 'ollama',
      name: 'Ollama',
      baseUrl: 'http://ollama:11434',
    });
    await ai.assign({ purpose: 'embedding', providerId: provider.id, model: 'bge-m3' });
    await ai.assign({ purpose: 'generation', providerId: provider.id, model: 'qwen3' });
    await ai.unassign('generation');
    expect(await ai.embeddingSource()).not.toBeNull();
    expect((await ai.settings()).embeddingsEnabled).toBe(true);
  });
});

describe('testing a model that writes', () => {
  const at = { kind: 'ollama' as const, baseUrl: 'http://ollama:11434', model: 'qwen3' };

  it('answers with what the model said', async () => {
    // The only proof a generation model works is reading one answer from it.
    // A dimension proves an embedding model; there is no equivalent here.
    const ai = service({ generation: () => writer('It says the ledger only grows.') });
    const outcome = await ai.testGeneration(at);
    expect(outcome).toMatchObject({
      ok: true,
      text: 'It says the ledger only grows.',
      error: null,
    });
    expect(outcome.latencyMs).not.toBeNull();
  });

  it('is a failure when the model says nothing', async () => {
    // A model that answers in ten milliseconds with an empty string has not
    // worked, and reporting it as working is how somebody assigns it.
    const ai = service({ generation: () => writer('   ') });
    expect(await ai.testGeneration(at)).toMatchObject({ ok: false, text: null });
  });

  it('reports why it failed rather than throwing', async () => {
    const ai = service({ generation: () => writer('', 'model "qwen3" not found') });
    const outcome = await ai.testGeneration(at);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not found');
  });

  it('says so when the build cannot generate at all', async () => {
    const outcome = await service().testGeneration(at);
    expect(outcome).toMatchObject({ ok: false, error: 'this build cannot generate text' });
  });

  it('tests the address it was given rather than one that was saved', async () => {
    // A form that can only test what has already been stored teaches people to
    // store things that do not work (ADR 0021).
    const seen: string[] = [];
    const ai = service({
      generation: (spec) => {
        seen.push(spec.baseUrl);
        return writer('ok');
      },
    });
    await ai.testGeneration({ ...at, baseUrl: 'http://typed-just-now:11434/' });
    expect(seen).toEqual(['http://typed-just-now:11434']);
  });

  it('bounds what it carries back', async () => {
    const ai = service({ generation: () => writer('x'.repeat(4000)) });
    const outcome = await ai.testGeneration(at);
    expect(outcome.text?.length).toBeLessThanOrEqual(500);
  });
});

describe('configuring a provider', () => {
  it('refuses a second provider at the same address', async () => {
    // Two rows for one server are two places to change a setting, and one of
    // them will be forgotten.
    const ai = service();
    await ai.save({ kind: 'ollama', name: 'Ollama', baseUrl: 'http://ollama:11434' });
    await expect(
      ai.save({ kind: 'ollama', name: 'The same one', baseUrl: 'http://ollama:11434/' }),
    ).rejects.toThrow(DomainError);
  });

  it('lets a provider keep its own address while being renamed', async () => {
    const ai = service();
    const first = await ai.save({ kind: 'ollama', name: 'Ollama', baseUrl: 'http://ollama:11434' });
    const renamed = await ai.save({
      providerId: first.id,
      kind: 'ollama',
      name: 'The big machine',
      baseUrl: 'http://ollama:11434',
    });
    expect(renamed.name).toBe('The big machine');
  });

  it('says a change came from whoever made it, whatever the first start read', async () => {
    // The question an operator asks first when the compose file and the
    // settings page disagree.
    const ai = service();
    await ai.seed({ kind: 'ollama', baseUrl: 'http://ollama:11434', model: 'bge-m3' });
    const [seeded] = (await ai.settings()).providers;
    expect(seeded?.origin).toBe('environment');
    const changed = await ai.save({
      providerId: seeded?.id as AiProviderId,
      kind: 'ollama',
      name: 'Ollama',
      baseUrl: 'http://elsewhere:11434',
    });
    expect(changed.origin).toBe('interface');
  });
});

describe('the environment seed', () => {
  it('configures a first start and is not read again', async () => {
    // An installation configured through the interface must not be reset by a
    // compose file somebody forgot to update (ADR 0021).
    const ai = service();
    expect(await ai.seed({ kind: 'ollama', baseUrl: 'http://a:11434', model: 'bge-m3' })).toBe(
      true,
    );
    expect(await ai.seed({ kind: 'ollama', baseUrl: 'http://b:11434', model: 'other' })).toBe(
      false,
    );
    const view = await ai.settings();
    expect(view.providers).toHaveLength(1);
    expect(view.providers[0]?.baseUrl).toBe('http://a:11434');
    expect(view.assignments[0]?.model).toBe('bge-m3');
  });
});

describe('probing an address', () => {
  it('answers what it found rather than throwing, because that is the finding', async () => {
    const ai = build({
      repository: repository(),
      probe: async () => {
        throw new Error('connect ECONNREFUSED 192.168.1.7:11434');
      },
    });
    const outcome = await ai.check({ kind: 'ollama', baseUrl: 'http://192.168.1.7:11434' });
    expect(outcome.reachable).toBe(false);
    expect(outcome.error).toContain('ECONNREFUSED');
    expect(outcome.models).toEqual([]);
  });

  it('records the outcome against an address that is already configured', async () => {
    const repo = repository();
    const ai = build({
      repository: repo,
      probe: async () => ({ version: '0.32.13', models: [{ name: 'bge-m3', capabilities: [] }] }),
    });
    const saved = await ai.save({ kind: 'ollama', name: 'Ollama', baseUrl: 'http://ollama:11434' });
    await ai.check({ kind: 'ollama', baseUrl: 'http://ollama:11434' });
    const stored = await repo.findProvider(saved.id);
    expect(stored?.lastCheckedAt).not.toBeNull();
    expect(stored?.lastError).toBeNull();
  });

  it('probes an address nothing is saved for, so a wizard can test what was typed', async () => {
    // A form that can only test what has already been stored teaches people
    // to store things that do not work.
    const repo = repository();
    const ai = build({
      repository: repo,
      probe: async () => ({ models: [{ name: 'bge-m3:latest', capabilities: ['embedding'] }] }),
    });
    const outcome = await ai.check({ kind: 'ollama', baseUrl: 'http://nothing-saved:11434' });
    expect(outcome.reachable).toBe(true);
    expect(outcome.models[0]?.capabilities).toEqual(['embedding']);
    expect(await repo.providers()).toEqual([]);
  });
});

describe('testing a model', () => {
  it('reports the dimension, because nobody configures it', async () => {
    const ai = service();
    const outcome = await ai.test({
      kind: 'ollama',
      baseUrl: 'http://o:11434',
      model: 'bge-m3',
    });
    expect(outcome).toMatchObject({ ok: true, dimensions: 1024 });
    expect(outcome.error).toBeNull();
  });

  it('fails on a model that is not an embedding model, before anything is saved', async () => {
    // The point of being able to run it first: a generative model chosen as
    // an embedding model costs a rebuild and answers nothing useful.
    const repo = repository();
    const ai = build({
      repository: repo,
      embeddings: () => embedder(0, 'does not support generate'),
    });
    const outcome = await ai.test({
      kind: 'ollama',
      baseUrl: 'http://o:11434',
      model: 'gpt-oss:120b',
    });
    expect(await repo.providers()).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('does not support generate');
  });
});

describe('what embeds now', () => {
  it('answers with the assigned model, and stops when it is unassigned', async () => {
    const ai = service();
    const provider = await ai.save({ kind: 'ollama', name: 'O', baseUrl: 'http://o:11434' });
    expect(await ai.embeddingSource()).toBeNull();
    await ai.assign({ purpose: 'embedding', providerId: provider.id, model: 'bge-m3' });
    expect(await ai.embeddingSource()).not.toBeNull();
    await ai.unassign('embedding');
    expect(await ai.embeddingSource()).toBeNull();
  });

  it('keeps one provider between calls, so the dimension it learned survives', async () => {
    // Not an optimisation: a fresh instance per call would report zero
    // dimensions forever, which is how a profile fails to be recognised.
    const build = vi.fn(() => embedder(1024));
    const ai = service({ embeddings: build });
    const provider = await ai.save({ kind: 'ollama', name: 'O', baseUrl: 'http://o:11434' });
    await ai.assign({ purpose: 'embedding', providerId: provider.id, model: 'bge-m3' });
    const first = await ai.embeddingSource();
    await first?.embed(['learn the dimension']);
    const second = await ai.embeddingSource();
    expect(second).toBe(first);
    expect(second?.profile.dimensions).toBe(1024);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('builds a new one when the model changes', async () => {
    const build = vi.fn(() => embedder(1024));
    const ai = service({ embeddings: build });
    const provider = await ai.save({ kind: 'ollama', name: 'O', baseUrl: 'http://o:11434' });
    await ai.assign({ purpose: 'embedding', providerId: provider.id, model: 'bge-m3' });
    const first = await ai.embeddingSource();
    await ai.assign({ purpose: 'embedding', providerId: provider.id, model: 'nomic-embed-text' });
    expect(await ai.embeddingSource()).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('builds a new one when another process moved the provider', async () => {
    // The API and the worker are separable roles, so the process that
    // embeds is often not the one somebody changed the address in. Changed
    // through the repository, which is what that looks like from here.
    const repo = repository();
    const build = vi.fn((_spec: { kind: string; baseUrl: string; model: string }) =>
      embedder(1024),
    );
    const ai = build2(repo, build);
    const provider = await ai.save({ kind: 'ollama', name: 'O', baseUrl: 'http://o:11434' });
    await ai.assign({ purpose: 'embedding', providerId: provider.id, model: 'bge-m3' });
    await ai.embeddingSource();
    await repo.updateProvider(provider.id, {
      baseUrl: 'http://moved:11434',
      updatedAt: new Date(provider.updatedAt.getTime() + 1000),
    });
    await ai.embeddingSource();
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[1]?.[0]).toMatchObject({ baseUrl: 'http://moved:11434' });
  });
});

describe('removing a provider', () => {
  it('takes what it was doing with it, rather than leaving an assignment pointing at nothing', async () => {
    // An assignment with no provider reads as configured and embeds nothing.
    const ai = service();
    const provider = await ai.save({ kind: 'ollama', name: 'O', baseUrl: 'http://o:11434' });
    await ai.assign({ purpose: 'embedding', providerId: provider.id, model: 'bge-m3' });
    await ai.remove(provider.id);
    const view = await ai.settings();
    expect(view.assignments).toEqual([]);
    expect(view.embeddingsEnabled).toBe(false);
    expect(await ai.embeddingSource()).toBeNull();
  });

  it('refuses to remove one that is not there', async () => {
    const ai = service();
    await expect(ai.remove('aip_01M2XNOTHINGNOTHINGNOTH1' as AiProviderId)).rejects.toThrow(
      DomainError,
    );
  });
});
