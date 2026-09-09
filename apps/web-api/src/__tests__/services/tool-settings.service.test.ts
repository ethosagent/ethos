import { DefaultToolRegistry } from '@ethosagent/core';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { isEthosError, type Tool } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { NamedSecretsService } from '../../services/named-secrets.service';
import { PersonalitiesService } from '../../services/personalities.service';
import { ToolSettingsService, type ToolSettingsValues } from '../../services/tool-settings.service';

const DATA = '/data';

// Minimal stand-in for the web_search tool (web-api does not depend on
// @ethosagent/tools-web). It declares the same-shaped settingsSchema.
const webSearchStub: Tool = {
  name: 'web_search',
  description: 'stub',
  schema: {},
  capabilities: {},
  settingsSchema: {
    fields: [
      {
        kind: 'enum',
        key: 'provider',
        label: 'Provider',
        options: [{ value: 'exa' }, { value: 'tavily' }, { value: 'brave' }],
      },
      { kind: 'secret-binding', key: 'secret', label: 'API key', secretKind: 'web-search' },
    ],
  },
  async execute() {
    return { ok: true, value: '' };
  },
};

// The two YouTube tools share ONE Google key, so both declare the same
// `settingsKey` and the settings UI renders a single form. Stand-ins here for
// the same reason as above; the real declarations are pinned in
// packages/wiring/src/__tests__/social-search-tools.test.ts.
const youtubeSecretSchema: Tool['settingsSchema'] = {
  fields: [
    {
      kind: 'secret-binding',
      key: 'secret',
      label: 'Google API key (YouTube)',
      secretKind: 'youtube-api-key',
    },
  ],
};
const youtubeSearchStub: Tool = {
  name: 'youtube_search',
  description: 'stub',
  schema: {},
  capabilities: {},
  settingsKey: 'youtube',
  settingsSchema: youtubeSecretSchema,
  async execute() {
    return { ok: true, value: '' };
  },
};
const youtubeCommentsStub: Tool = { ...youtubeSearchStub, name: 'youtube_comments' };

describe('ToolSettingsService', () => {
  let storage: InMemoryStorage;
  let config: ConfigRepository;
  let personalities: PersonalitiesService;
  let service: ToolSettingsService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir(DATA);
    // Custom personality (under the user dir → builtin: false).
    await storage.mkdir('/data/personalities/mine');
    await storage.write('/data/personalities/mine/config.yaml', 'name: Mine\n');
    await storage.write('/data/personalities/mine/SOUL.md', '# Mine\n');
    // Built-in personality (outside the user dir → builtin: true, read-only).
    await storage.mkdir('/builtins/scout');
    await storage.write('/builtins/scout/config.yaml', 'name: Scout\n');
    await storage.write('/builtins/scout/SOUL.md', '# Scout\n');

    const registry = new FilePersonalityRegistry(storage, DATA);
    await registry.loadFromDirectory('/builtins');
    await registry.loadFromDirectory('/data/personalities');

    const library = new SkillsLibrary({ dataDir: DATA, storage });
    personalities = new PersonalitiesService({ personalities: registry, library });
    config = new ConfigRepository({
      dataDir: DATA,
      storage,
      secrets: new InMemorySecretsResolver(),
    });

    const toolRegistry = new DefaultToolRegistry();
    toolRegistry.register(webSearchStub);
    service = new ToolSettingsService({ config, personalities, toolRegistry });
  });

  it('schemas() exposes web_search settingsSchema from the registry', () => {
    const { tools } = service.schemas();
    const ws = tools.find((t) => t.name === 'web_search');
    if (!ws) throw new Error('expected web_search schema');
    const kinds = ws.settingsSchema.fields.map((f) => f.kind);
    expect(kinds).toEqual(['enum', 'secret-binding']);
  });

  it('global default round-trips through config.yaml', async () => {
    await service.setDefault({ web_search: { provider: 'exa', secret: 'main' } });
    const raw = await storage.read('/data/config.yaml');
    expect(raw).toContain('toolSettings._default.web_search.provider: exa');
    expect(raw).toContain('toolSettings._default.web_search.secret: main');

    const got = await service.getDefault();
    expect(got.values.web_search).toEqual({ provider: 'exa', secret: 'main' });
  });

  it('built-in personality binding lands in the global toolSettings slot', async () => {
    const res = await service.setForPersonality('scout', {
      web_search: { provider: 'brave', secret: 'scout-key' },
    });
    expect(res.storage).toBe('global');

    const raw = await storage.read('/data/config.yaml');
    expect(raw).toContain('toolSettings.scout.web_search.provider: brave');
    // A built-in never gets a tools.yaml written into its (read-only) dir.
    expect(await storage.exists('/builtins/scout/tools.yaml')).toBe(false);

    const got = await service.getForPersonality('scout');
    expect(got.storage).toBe('global');
    expect(got.values.web_search).toEqual({ provider: 'brave', secret: 'scout-key' });
  });

  it('custom personality binding lands in its own tools.yaml, not the config', async () => {
    const res = await service.setForPersonality('mine', {
      web_search: { provider: 'exa', secret: 'mine-key' },
    });
    expect(res.storage).toBe('personality');

    const toolsYaml = await storage.read('/data/personalities/mine/tools.yaml');
    expect(toolsYaml).toContain('web_search:');
    expect(toolsYaml).toContain('provider: exa');
    expect(toolsYaml).toContain('secret: mine-key');

    // The custom binding must NOT leak into the global config slot.
    const raw = (await storage.read('/data/config.yaml')) ?? '';
    expect(raw).not.toContain('toolSettings.mine');

    const got = await service.getForPersonality('mine');
    expect(got.storage).toBe('personality');
    expect(got.values.web_search).toEqual({ provider: 'exa', secret: 'mine-key' });
  });

  it('only the secret NAME reaches a personality dir — never the raw value', async () => {
    // Seed a REAL raw value into the vault under the bound name, then bind by
    // name. The raw value genuinely exists in the system, so asserting its
    // absence from tools.yaml is a meaningful boundary check (not a no-op).
    const RAW_VALUE = 'sk-exa-RAW-SECRET-VALUE-4f2a9c';
    const secrets = new InMemorySecretsResolver();
    const vault = new NamedSecretsService({ secrets });
    await vault.create({ provider: 'exa', name: 'mine-key', value: RAW_VALUE });
    expect(await secrets.get('providers/exa/mine-key')).toBe(RAW_VALUE);

    await service.setForPersonality('mine', {
      web_search: { provider: 'exa', secret: 'mine-key' },
    });
    const toolsYaml = (await storage.read('/data/personalities/mine/tools.yaml')) ?? '';
    // The binding is a reference (the name), never the resolved value.
    expect(toolsYaml).toContain('mine-key');
    expect(toolsYaml).not.toContain(RAW_VALUE);
    expect(toolsYaml).not.toContain('RAW-SECRET-VALUE');
  });

  it('x_search binding round-trips beside web_search in both stores', async () => {
    const values: ToolSettingsValues = {
      web_search: { provider: 'exa', secret: 'exa-main' },
      x_search: { secret: 'xai-main' },
    };
    await service.setForPersonality('scout', values);
    expect(await storage.read('/data/config.yaml')).toContain(
      'toolSettings.scout.x_search.secret: xai-main',
    );
    expect((await service.getForPersonality('scout')).values).toEqual(values);

    await service.setForPersonality('mine', values);
    const toolsYaml = (await storage.read('/data/personalities/mine/tools.yaml')) ?? '';
    expect(toolsYaml).toContain('x_search: { secret: xai-main }');
    expect((await service.getForPersonality('mine')).values).toEqual(values);
  });

  it('engine_ask binding round-trips beside the others in both stores', async () => {
    const values: ToolSettingsValues = {
      web_search: { provider: 'exa', secret: 'exa-main' },
      x_search: { secret: 'xai-main' },
      engine_ask: { secret: 'openai-brand' },
    };
    await service.setForPersonality('scout', values);
    expect(await storage.read('/data/config.yaml')).toContain(
      'toolSettings.scout.engine_ask.secret: openai-brand',
    );
    expect((await service.getForPersonality('scout')).values).toEqual(values);

    await service.setForPersonality('mine', values);
    const toolsYaml = (await storage.read('/data/personalities/mine/tools.yaml')) ?? '';
    expect(toolsYaml).toContain('engine_ask: { secret: openai-brand }');
    expect((await service.getForPersonality('mine')).values).toEqual(values);
  });

  it('drops an unsafe engine_ask secret name instead of persisting it', async () => {
    await service.setForPersonality('mine', { engine_ask: { secret: '../xai/apiKey' } });
    expect(await storage.exists('/data/personalities/mine/tools.yaml')).toBe(false);
    expect((await service.getForPersonality('mine')).values).toEqual({});
  });

  it('drops an unsafe x_search secret name instead of persisting it', async () => {
    await service.setForPersonality('mine', { x_search: { secret: '../openai/apiKey' } });
    expect(await storage.exists('/data/personalities/mine/tools.yaml')).toBe(false);
    expect((await service.getForPersonality('mine')).values).toEqual({});
  });

  it('web_search recency survives write-then-read in both stores', async () => {
    const values: ToolSettingsValues = {
      web_search: { provider: 'exa', secret: 'exa-main', recency: '30d' },
    };

    // Built-in → the global config slot.
    await service.setForPersonality('scout', values);
    expect(await storage.read('/data/config.yaml')).toContain(
      'toolSettings.scout.web_search.recency: 30d',
    );
    expect((await service.getForPersonality('scout')).values).toEqual(values);

    // Custom → its own tools.yaml.
    await service.setForPersonality('mine', values);
    const toolsYaml = (await storage.read('/data/personalities/mine/tools.yaml')) ?? '';
    expect(toolsYaml).toContain('recency: 30d');
    expect((await service.getForPersonality('mine')).values).toEqual(values);

    // And the global default slot.
    await service.setDefault(values);
    expect(await storage.read('/data/config.yaml')).toContain(
      'toolSettings._default.web_search.recency: 30d',
    );
    expect((await service.getDefault()).values).toEqual(values);
  });

  it('drops an out-of-shape recency without losing the rest of the binding', async () => {
    for (const bad of ['last month', '30x', 'abc', '']) {
      await service.setForPersonality('mine', {
        web_search: { provider: 'exa', secret: 'exa-main', recency: bad },
      });
      const toolsYaml = (await storage.read('/data/personalities/mine/tools.yaml')) ?? '';
      expect(toolsYaml).not.toContain('recency');
      expect((await service.getForPersonality('mine')).values.web_search).toEqual({
        provider: 'exa',
        secret: 'exa-main',
      });
    }
  });

  it('normalizes a recency instead of dropping it, in every store', async () => {
    // A value that reaches the service with stray casing or spaces (a
    // hand-edited config, or a client that did not trim) must survive as the
    // normalized form rather than vanishing.
    const written: ToolSettingsValues = {
      web_search: { provider: 'exa', secret: 'exa-main', recency: ' 30D ' },
    };
    const stored = { provider: 'exa', secret: 'exa-main', recency: '30d' };

    await service.setForPersonality('scout', written);
    expect(await storage.read('/data/config.yaml')).toContain(
      'toolSettings.scout.web_search.recency: 30d',
    );
    expect((await service.getForPersonality('scout')).values.web_search).toEqual(stored);

    await service.setForPersonality('mine', written);
    expect(await storage.read('/data/personalities/mine/tools.yaml')).toContain('recency: 30d');
    expect((await service.getForPersonality('mine')).values.web_search).toEqual(stored);

    await service.setDefault({ web_search: { recency: '6M' } });
    expect(await storage.read('/data/config.yaml')).toContain(
      'toolSettings._default.web_search.recency: 6m',
    );
    expect((await service.getDefault()).values.web_search).toEqual({ recency: '6m' });
  });

  // -------------------------------------------------------------------------
  // Partial payload × whole-slot replace — the erasure bug (D23).
  //
  // The Security pane owns ONE form and sends `{ web_search: … }` and nothing
  // else (`apps/web/src/pages/settings/panes/security.tsx`). It never reads the
  // other bindings, so it cannot resend them. A test that round-trips the FULL
  // values object — the shape PersonalityDetail sends, because it seeds its
  // state from the full read — passes whatever the write side does with the
  // keys the payload omits, so it cannot catch this. Every test below sends a
  // partial payload on purpose.
  // -------------------------------------------------------------------------

  it('a single-key web_search save keeps the other global default bindings', async () => {
    await service.setDefault({
      web_search: { provider: 'exa', secret: 'exa-main' },
      x_search: { secret: 'xai-main' },
      engine_ask: { secret: 'openai-main' },
    });

    // Exactly what the Security pane sends: its own form's values, alone.
    await service.setDefault({ web_search: { provider: 'brave', secret: 'brave-main' } });

    const got = await service.getDefault();
    expect(got.values).toEqual({
      web_search: { provider: 'brave', secret: 'brave-main' },
      x_search: { secret: 'xai-main' },
      engine_ask: { secret: 'openai-main' },
    });
    const raw = (await storage.read('/data/config.yaml')) ?? '';
    expect(raw).toContain('toolSettings._default.x_search.secret: xai-main');
    expect(raw).toContain('toolSettings._default.engine_ask.secret: openai-main');
  });

  it('a single-key save keeps the other bindings in a built-in personality slot', async () => {
    await service.setForPersonality('scout', {
      web_search: { provider: 'exa', secret: 'exa-main' },
      x_search: { secret: 'xai-main' },
      youtube: { secret: 'google-main' },
    });

    await service.setForPersonality('scout', { engine_ask: { secret: 'openai-main' } });

    expect((await service.getForPersonality('scout')).values).toEqual({
      web_search: { provider: 'exa', secret: 'exa-main' },
      x_search: { secret: 'xai-main' },
      engine_ask: { secret: 'openai-main' },
      youtube: { secret: 'google-main' },
    });
  });

  it("a single-key save keeps a custom personality's other tools.yaml lines", async () => {
    await service.setForPersonality('mine', {
      youtube: { secret: 'google-main' },
      x_search: { secret: 'xai-main' },
    });
    expect(await storage.read('/data/personalities/mine/tools.yaml')).toContain(
      'youtube: { secret: google-main }',
    );

    // Save one unrelated binding — the youtube line must survive a whole-file
    // re-render that only ever sees the incoming payload.
    await service.setForPersonality('mine', {
      web_search: { provider: 'exa', secret: 'exa-mine' },
    });

    const toolsYaml = (await storage.read('/data/personalities/mine/tools.yaml')) ?? '';
    expect(toolsYaml).toContain('youtube: { secret: google-main }');
    expect(toolsYaml).toContain('x_search: { secret: xai-main }');
    expect((await service.getForPersonality('mine')).values).toEqual({
      web_search: { provider: 'exa', secret: 'exa-mine' },
      x_search: { secret: 'xai-main' },
      youtube: { secret: 'google-main' },
    });
  });

  it('a key the payload DOES carry still clears when its value is empty or invalid', async () => {
    // Merge semantics must not turn into "never clears": a form the operator
    // emptied has to unset the binding, and an unsafe name still drops.
    await service.setForPersonality('mine', {
      web_search: { provider: 'exa', secret: 'exa-mine' },
      x_search: { secret: 'xai-main' },
    });

    await service.setForPersonality('mine', { x_search: { secret: '' } });
    expect((await service.getForPersonality('mine')).values).toEqual({
      web_search: { provider: 'exa', secret: 'exa-mine' },
    });

    await service.setForPersonality('mine', { web_search: { provider: '', secret: '' } });
    expect(await storage.exists('/data/personalities/mine/tools.yaml')).toBe(false);
  });

  it('a youtube binding survives the global slot and reaches the UI shape', async () => {
    // Modelled in storage and rendered to tools.yaml, but `fromSlot` never read
    // it and the config repository never parsed it — so the binding could not
    // be displayed or re-saved from either store.
    await service.setDefault({ youtube: { secret: 'google-main' } });
    expect(await storage.read('/data/config.yaml')).toContain(
      'toolSettings._default.youtube.secret: google-main',
    );
    expect((await service.getDefault()).values).toEqual({ youtube: { secret: 'google-main' } });
  });

  it('drops an unsafe youtube secret name instead of persisting it', async () => {
    await service.setForPersonality('mine', { youtube: { secret: '../openai/apiKey' } });
    expect(await storage.exists('/data/personalities/mine/tools.yaml')).toBe(false);
    expect((await service.getForPersonality('mine')).values).toEqual({});
  });

  it('schemas() reports a tool settingsKey so the UI can group shared credentials', () => {
    const registry = new DefaultToolRegistry();
    registry.register(webSearchStub);
    registry.register(youtubeSearchStub);
    registry.register(youtubeCommentsStub);
    const grouped = new ToolSettingsService({ config, personalities, toolRegistry: registry });

    const { tools } = grouped.schemas();
    expect(tools.find((t) => t.name === 'youtube_search')?.settingsKey).toBe('youtube');
    expect(tools.find((t) => t.name === 'youtube_comments')?.settingsKey).toBe('youtube');
    // A tool that does not declare one omits the field entirely — the client
    // falls back to the tool name.
    expect(tools.find((t) => t.name === 'web_search')).not.toHaveProperty('settingsKey');
  });

  it('rejects a reserved / unsafe personality id used as a config slot key', async () => {
    // A built-in id flows straight into `toolSettings[<id>]` as a computed key.
    // `__proto__` and friends must never become serialized own-keys (a
    // prototype-pollution reservoir). Exercise the internal global-slot writer,
    // which no real built-in id could ever carry these shapes to.
    const writer = service as unknown as {
      writeGlobalSlot(p: string, v: ToolSettingsValues): Promise<void>;
    };
    for (const pid of ['__proto__', 'constructor', 'prototype', 'bad/id', 'bad key']) {
      let threw = false;
      try {
        await writer.writeGlobalSlot(pid, { web_search: { provider: 'exa', secret: 'k' } });
      } catch (err) {
        threw = true;
        expect(isEthosError(err)).toBe(true);
      }
      expect(threw).toBe(true);
    }
    // Nothing unsafe reached the written config.
    const raw = (await storage.read('/data/config.yaml')) ?? '';
    expect(raw).not.toContain('__proto__');
  });
});
