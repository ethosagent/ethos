// @vitest-environment jsdom
//
// Settings → Models › providers & models, driven through the real Antd controls
// (the approved "Providers & models" mockup; plan/phases/model-registry.md
// T2.3, T2.4, T2.7, T2.8, T2.12). Real DOM for the same reason
// `components/mcp/__tests__/AddMcpModal.test.ts` has one: Select renders its
// options into a portal on `document.body` only once opened, and the drawers,
// the confirm and the removal dialog are portals too — so assertions run
// against `document.body`. Its `matchMedia` / `ResizeObserver` stubs are
// reused verbatim.
//
// The registry list and the catalog are seeded into the query cache; the RPCs
// are spies. Each test asserts the WRITE a click produces, which is the thing
// the operator's config.yaml actually sees. What each click decides is pinned
// separately, without a DOM, in `model-registry-lib.test.ts` and
// `settings-provider-rows.test.ts`.

import type {
  ModelReferent,
  ModelRegistryListResult,
  ModelRegistryTestResult,
} from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, Form } from 'antd';
import { act, cloneElement, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelCatalogKey, modelRegistryKeys } from '../lib/model-registry';
import { resetModelTestLog } from '../lib/model-test-log';
import type { SettingsPaneContext } from '../pane-context';
import { CATALOG, chainModel, providerEntry, registryList } from './model-registry-fixture';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const listFn = vi.fn();
const catalogFn = vi.fn();
const upsertFn = vi.fn();
const setDefaultFn = vi.fn();
const setRoleFn = vi.fn();
const setRoutingFn = vi.fn();
const removeFn = vi.fn();
const testFn = vi.fn();
const testAllFn = vi.fn();
const importChainFn = vi.fn();
const addProviderFn = vi.fn();
const updateProviderFn = vi.fn();
const removeProviderFn = vi.fn();
const moveProviderFn = vi.fn();
const setProviderFailoverFn = vi.fn();
const setFallbackModelFn = vi.fn();
const testProviderFn = vi.fn();
const validateProviderFn = vi.fn();
const configGetFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    modelRegistry: {
      list: (...args: unknown[]) => listFn(...args),
      upsert: (...args: unknown[]) => upsertFn(...args),
      setDefault: (...args: unknown[]) => setDefaultFn(...args),
      setRole: (...args: unknown[]) => setRoleFn(...args),
      setRouting: (...args: unknown[]) => setRoutingFn(...args),
      remove: (...args: unknown[]) => removeFn(...args),
      test: (...args: unknown[]) => testFn(...args),
      testAll: (...args: unknown[]) => testAllFn(...args),
      importChain: (...args: unknown[]) => importChainFn(...args),
      addProvider: (...args: unknown[]) => addProviderFn(...args),
      updateProvider: (...args: unknown[]) => updateProviderFn(...args),
      removeProvider: (...args: unknown[]) => removeProviderFn(...args),
      moveProvider: (...args: unknown[]) => moveProviderFn(...args),
      setProviderFailover: (...args: unknown[]) => setProviderFailoverFn(...args),
      setFallbackModel: (...args: unknown[]) => setFallbackModelFn(...args),
      testProvider: (...args: unknown[]) => testProviderFn(...args),
    },
    models: { catalog: (...args: unknown[]) => catalogFn(...args) },
    onboarding: { validateProvider: (...args: unknown[]) => validateProviderFn(...args) },
    config: { get: (...args: unknown[]) => configGetFn(...args) },
  },
}));

const { ModelRegistrySection } = await import('../components/model-registry-section');
const { ModelRoutingSection } = await import('../components/model-routing-section');
const { ModelsPane } = await import('../panes/models');

let container: HTMLDivElement;
let root: Root;
let current: ReactElement;
let queryClient: QueryClient;

function mount(node: ReactElement, list: ModelRegistryListResult = registryList()): void {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(modelRegistryKeys.list(), list);
  queryClient.setQueryData(modelCatalogKey(), CATALOG);
  listFn.mockResolvedValue(list);
  current = node;
  act(() => root.render(tree(node)));
}

function tree(node: ReactElement): ReactElement {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(AntApp, null, node),
  );
}

/**
 * Re-render the section — what the cooldown clock's interval does. The node is
 * cloned because React bails out of an identical element and would never
 * re-read the clock.
 */
function rerender(): void {
  current = cloneElement(current);
  act(() => root.render(tree(current)));
}

/** Drain the RPC promise, the refetch it triggers, and React's commit. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el, 'nothing to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

function buttonByText(text: string, scope: ParentNode = document.body): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button, `missing button: ${text}`).toBeDefined();
  return button as HTMLButtonElement;
}

function groupFor(providerKey: string): HTMLElement {
  const group = document.body.querySelector<HTMLElement>(
    `.settings-models .settings-provider-group[data-provider-key="${providerKey}"]`,
  );
  expect(group, `missing provider group: ${providerKey}`).not.toBeNull();
  return group as HTMLElement;
}

function rowFor(alias: string): HTMLElement {
  const row = document.body.querySelector<HTMLElement>(
    `.settings-models .settings-model-row[data-alias="${alias}"]`,
  );
  expect(row, `missing row: ${alias}`).not.toBeNull();
  return row as HTMLElement;
}

function testButtonIn(row: Element): HTMLButtonElement {
  const button = Array.from(row.querySelectorAll('button')).find((b) =>
    b.textContent?.startsWith('Test'),
  );
  expect(button, 'missing Test button').toBeDefined();
  return button as HTMLButtonElement;
}

/** The control a visible `<label>` names. */
function fieldByLabel(text: string): HTMLInputElement {
  const label = Array.from(document.body.querySelectorAll('label')).find(
    (l) => l.textContent?.trim() === text,
  );
  expect(label, `missing label: ${text}`).toBeDefined();
  const input = document.getElementById(label?.htmlFor ?? '');
  expect(input, `label "${text}" names no control`).not.toBeNull();
  return input as HTMLInputElement;
}

/** Antd v6 opens a Select on mousedown of `.ant-select-content`. */
function openSelect(scope: ParentNode, index = 0): void {
  const selector = scope.querySelectorAll('.ant-select-content')[index];
  expect(selector, `missing select #${index}`).toBeDefined();
  act(() => {
    selector?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

function openOptions(): string[] {
  return Array.from(document.body.querySelectorAll('.ant-select-item-option')).map(
    (el) => el.textContent ?? '',
  );
}

async function chooseOption(startsWith: string): Promise<void> {
  const option = Array.from(document.body.querySelectorAll('.ant-select-item-option')).find((el) =>
    el.textContent?.startsWith(startsWith),
  );
  expect(option, `missing option: ${startsWith}`).toBeDefined();
  await act(async () => {
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** React tracks input state off the native setter, so bypass the wrapper. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function drawer(className = 'ant-drawer'): Element {
  const el = document.body.querySelector(`.${className}`);
  expect(el, `${className} is not open`).not.toBeNull();
  return el as Element;
}

function modalRoot(): Element {
  const el = document.body.querySelector('.ant-modal');
  expect(el, 'no confirm is open').not.toBeNull();
  return el as Element;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetModelTestLog();
  upsertFn.mockResolvedValue({ ok: true });
  setDefaultFn.mockResolvedValue({ ok: true });
  setRoleFn.mockResolvedValue({ ok: true });
  setRoutingFn.mockResolvedValue({ ok: true });
  const providerOk = { ok: true, providerKey: 'x', index: 0 };
  moveProviderFn.mockResolvedValue(providerOk);
  setProviderFailoverFn.mockResolvedValue(providerOk);
  setFallbackModelFn.mockResolvedValue(providerOk);
  updateProviderFn.mockResolvedValue(providerOk);
  importChainFn.mockResolvedValue({ ok: true, adopted: [], defaultSet: null, idsWritten: [] });
  configGetFn.mockResolvedValue({ providers: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('providers & models — one list, grouped by provider', () => {
  it('lists every model under its provider, providers in chain order', () => {
    mount(
      createElement(ModelRegistrySection),
      registryList({
        // Shuffled on purpose: the list is ordered by chain position, not array order.
        providerEntries: [
          providerEntry('openai-main', 2, 'openai', { credential: 'missing' }),
          providerEntry('anthropic-work', 0, 'anthropic'),
          providerEntry('local-ollama', 1, 'ollama', { credential: 'not_needed' }),
        ],
      }),
    );
    const groups = Array.from(
      document.body.querySelectorAll<HTMLElement>('.settings-models .settings-provider-group'),
    ).map((g) => [
      g.dataset.providerKey,
      Array.from(g.querySelectorAll<HTMLElement>('.settings-model-row')).map(
        (r) => r.dataset.alias,
      ),
    ]);
    expect(groups).toEqual([
      ['anthropic-work', ['sonnet', 'opus']],
      ['local-ollama', ['qwen']],
      ['openai-main', ['gpt']],
    ]);
    expect(groupFor('anthropic-work').textContent).toContain('Primary');
    expect(groupFor('local-ollama').textContent).toContain('Fallback 1');
    expect(groupFor('openai-main').textContent).toContain('✗ no key');
    // Model id, context and cost ride on the alias's sub-line.
    expect(rowFor('sonnet').textContent).toContain('claude-sonnet-5200K$0.003 · $0.015 / 1K');
  });

  it('the default radio is single-select across every provider', async () => {
    mount(createElement(ModelRegistrySection));
    const checked = () =>
      Array.from(
        document.body.querySelectorAll<HTMLInputElement>('.settings-models input[type="radio"]'),
      )
        .filter((r) => r.checked)
        .map((r) => r.closest<HTMLElement>('.settings-model-row')?.dataset.alias);
    expect(document.body.querySelectorAll('.settings-models input[type="radio"]')).toHaveLength(4);
    expect(checked()).toEqual(['sonnet']);

    listFn.mockResolvedValue(registryList({ default: 'qwen' }));
    await click(rowFor('qwen').querySelector('input[type="radio"]'));
    expect(setDefaultFn).toHaveBeenCalledWith({ alias: 'qwen' });
    expect(checked()).toEqual(['qwen']);
  });

  it('Up and Down move a provider through moveProvider', async () => {
    mount(createElement(ModelRegistrySection));
    const buttons = (key: string) =>
      Array.from(groupFor(key).querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons('anthropic-work')).not.toContain('Up');
    expect(buttons('anthropic')).not.toContain('Down');

    await click(buttonByText('Up', groupFor('local-ollama')));
    expect(moveProviderFn).toHaveBeenCalledWith({ key: 'local-ollama', direction: 'up' });
    await click(buttonByText('Down', groupFor('anthropic-work')));
    expect(moveProviderFn).toHaveBeenLastCalledWith({ key: 'anthropic-work', direction: 'down' });
    // Saved on its own, then re-read.
    expect(listFn).toHaveBeenCalled();
  });

  it('Failover writes setProviderFailover, and off hides the Fallback model', async () => {
    const list = registryList();
    list.providerEntries = list.providerEntries.map((e) =>
      e.key === 'local-ollama' ? { ...e, failover: false } : e,
    );
    mount(createElement(ModelRegistrySection), list);
    const ollama = groupFor('local-ollama');
    expect(ollama.textContent).toContain('credential only, not a fallback');
    expect(ollama.querySelector('.settings-fallback-model')).toBeNull();
    expect(groupFor('anthropic-work').querySelector('.settings-fallback-model')).not.toBeNull();

    await click(ollama.querySelector('[role="switch"]'));
    expect(setProviderFailoverFn).toHaveBeenCalledWith({ key: 'local-ollama', failover: true });
  });

  it('the Fallback model offers only that provider’s own models', async () => {
    const list = registryList();
    list.providerEntries = list.providerEntries.map((e) =>
      e.key === 'anthropic-work' ? { ...e, model: 'claude-sonnet-5' } : e,
    );
    mount(createElement(ModelRegistrySection), list);
    const work = groupFor('anthropic-work');
    expect(work.querySelector('.settings-fallback-model')?.textContent).toBe('sonnet');

    openSelect(work, 0);
    expect(openOptions()).toEqual(['None', 'sonnet', 'opus']);
    await chooseOption('opus');
    expect(setFallbackModelFn).toHaveBeenCalledWith({ key: 'anthropic-work', alias: 'opus' });
  });

  it('has no free-text model input anywhere in the list', () => {
    mount(
      createElement(ModelRegistrySection),
      registryList({ chainModels: [chainModel({ providerKey: 'anthropic', index: 3 })] }),
    );
    const inputs = Array.from(
      document.body.querySelectorAll<HTMLInputElement>(
        '.settings-models .settings-provider-group input',
      ),
    );
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      // A Default radio, or the closed Fallback model Select — never a text box.
      const closedSelect = input.closest('.ant-select') !== null && input.readOnly;
      expect(input.type === 'radio' || closedSelect, input.outerHTML).toBe(true);
    }
    expect(document.body.querySelector('.settings-models .ant-select-auto-complete')).toBeNull();
    expect(document.body.querySelector('.settings-models textarea')).toBeNull();
  });

  it('a provider refusal renders under that provider', async () => {
    setFallbackModelFn.mockResolvedValue({
      ok: false,
      code: 'cross_provider_alias',
      message: 'qwen is on local-ollama, not anthropic-work.',
      problems: [],
      aliases: ['sonnet', 'opus'],
    });
    mount(createElement(ModelRegistrySection));
    openSelect(groupFor('anthropic-work'), 0);
    await chooseOption('opus');
    expect(
      groupFor('anthropic-work').querySelector('.model-registry-refusal')?.textContent,
    ).toContain('qwen is on local-ollama, not anthropic-work.');
    expect(groupFor('local-ollama').querySelector('.model-registry-refusal')).toBeNull();
  });
});

describe('chain models not in the registry yet', () => {
  const idless = chainModel({
    providerKey: 'anthropic',
    index: 3,
    provider: 'anthropic',
    modelId: 'claude-opus-4-7',
    suggestedAlias: 'claude-opus-4-7',
    idIsExplicit: false,
  });
  const explicit = chainModel({
    providerKey: 'local-ollama',
    index: 1,
    provider: 'ollama',
    modelId: 'llama3.3:70b',
    suggestedAlias: 'llama3-3-70b',
    idIsExplicit: true,
  });

  it('shows under its provider, marked, and Add to models imports that provider only', async () => {
    mount(createElement(ModelRegistrySection), registryList({ chainModels: [idless] }));
    const pending = groupFor('anthropic').querySelector('.settings-model-row--pending');
    expect(pending?.textContent).toContain('claude-opus-4-7');
    expect(pending?.textContent).toContain('⚠ In provider chain, not in models yet');
    // Not a model yet, so it cannot be the default.
    expect(pending?.querySelector('input[type="radio"]')).toBeNull();

    await click(buttonByText('Add to models', pending as Element));
    expect(importChainFn).toHaveBeenCalledWith({ providerKeys: ['anthropic'] });
  });

  it('Add all confirms each alias and the providers.N.id it writes, then imports everything', async () => {
    mount(createElement(ModelRegistrySection), registryList({ chainModels: [explicit, idless] }));
    const banner = document.body.querySelector('.settings-models-unadopted');
    expect(banner?.textContent).toContain(
      "2 models in your provider chain aren't in models yet. Turns already run on them; adding them lets personalities and roles choose them.",
    );
    expect(banner?.textContent).toContain('Same as ethos migrate models');

    await click(buttonByText('Add all to models', banner as Element));
    expect(importChainFn).not.toHaveBeenCalled();
    const items = Array.from(document.body.querySelectorAll('.model-import-confirm li')).map(
      (li) => li.textContent,
    );
    expect(items).toEqual([
      'llama3-3-70b → local-ollama/llama3.3:70b',
      'claude-opus-4-7 → anthropic/claude-opus-4-7Also writes providers.3.id: anthropic, so models can name it.',
    ]);

    await click(buttonByText('Add all to models', modalRoot()));
    expect(importChainFn).toHaveBeenCalledWith({});
  });

  it('shows no banner when every chain model is in the registry', () => {
    mount(createElement(ModelRegistrySection));
    expect(document.body.querySelector('.settings-models-unadopted')).toBeNull();
  });
});

describe('adding a model to a provider (T2.4)', () => {
  async function openAddModel(providerKey: string): Promise<void> {
    mount(createElement(ModelRegistrySection));
    await click(buttonByText(`+ Add model to ${providerKey}`, groupFor(providerKey)));
  }

  it('opens the model drawer with that provider chosen and locked', async () => {
    await openAddModel('anthropic-work');
    const provider = fieldByLabel('Provider entry').closest('.ant-select');
    expect(provider?.className).toContain('ant-select-disabled');
    expect(provider?.textContent).toContain('anthropic-work');

    typeInto(fieldByLabel('Alias'), 'haiku');
    typeInto(fieldByLabel('Model id'), 'claude-haiku-4-5');
    typeInto(fieldByLabel('Label'), 'quick lookups');
    await click(buttonByText('Save model', drawer()));

    expect(upsertFn).toHaveBeenCalledWith({
      mode: 'create',
      alias: 'haiku',
      provider: 'anthropic-work',
      modelId: 'claude-haiku-4-5',
      label: 'quick lookups',
    });
    expect(listFn).toHaveBeenCalled();
  });

  it('a provider with no id cannot take a model, and Edit lists it disabled with the reason', async () => {
    mount(createElement(ModelRegistrySection));
    expect(buttonByText('+ Add model to anthropic', groupFor('anthropic')).disabled).toBe(true);

    await click(buttonByText('Edit', rowFor('sonnet')));
    openSelect(drawer(), 0);
    const option = Array.from(document.body.querySelectorAll('.ant-select-item-option')).find(
      (el) => el.textContent?.startsWith('anthropicadd an id'),
    );
    expect(option?.className).toContain('ant-select-item-option-disabled');
  });

  it('picking a catalogued model prefills context (the catalog has no cost to prefill)', async () => {
    await openAddModel('anthropic-work');
    typeInto(fieldByLabel('Model id'), 'claude-son');
    await chooseOption('claude-sonnet-5');

    expect(fieldByLabel('Model id').value).toBe('claude-sonnet-5');
    expect(fieldByLabel('Context window').value).toBe('200000');
    expect(drawer().textContent).toContain('From the catalog');
  });

  it('a hand-typed ollama id is accepted and saved', async () => {
    await openAddModel('local-ollama');
    typeInto(fieldByLabel('Alias'), 'coder');
    typeInto(fieldByLabel('Model id'), 'qwen2.5-coder:32b-instruct-q4_K_M');
    await click(buttonByText('Save model', drawer()));

    expect(upsertFn).toHaveBeenCalledWith({
      mode: 'create',
      alias: 'coder',
      provider: 'local-ollama',
      modelId: 'qwen2.5-coder:32b-instruct-q4_K_M',
    });
  });

  it('keeps the drawer open and shows a refusal inline', async () => {
    upsertFn.mockResolvedValue({
      ok: false,
      code: 'invalid_entry',
      message: 'The alias "deep" is reserved for a role.',
      problems: [
        {
          code: 'reserved_alias',
          alias: 'deep',
          key: 'modelRegistry.deep',
          message: 'deep is a role name.',
          fix: 'modelRegistry.deeper.provider: anthropic-work',
        },
      ],
      referents: [],
    });
    await openAddModel('anthropic-work');
    typeInto(fieldByLabel('Alias'), 'deep');
    typeInto(fieldByLabel('Model id'), 'claude-opus-5');
    await click(buttonByText('Save model', drawer()));

    const refusal = drawer().querySelector('.model-registry-refusal');
    expect(refusal?.textContent).toContain('The alias "deep" is reserved for a role.');
    expect(refusal?.textContent).toContain('Fix: modelRegistry.deeper.provider: anthropic-work');
  });
});

describe('Add provider (frame 3)', () => {
  async function connectAnthropic(): Promise<Element> {
    mount(createElement(ModelRegistrySection));
    await click(buttonByText('Add provider'));
    const add = drawer('add-provider-drawer');
    // `anthropic` is taken by the id-less entry, so the prefill moves on.
    expect(fieldByLabel('Id').value).toBe('anthropic-2');
    expect(buttonByText('Continue without testing', add).disabled).toBe(true);
    typeInto(fieldByLabel('API key'), 'sk-ant-test');
    return add;
  }

  it('tests the connection with validateProvider before continuing', async () => {
    validateProviderFn.mockResolvedValue({
      ok: true,
      models: ['claude-sonnet-5'],
      error: null,
      completionTested: true,
    });
    const add = await connectAnthropic();
    await click(buttonByText('Test connection', add));
    expect(validateProviderFn).toHaveBeenCalledWith({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(add.textContent).toContain('✓ Connected');
    await click(buttonByText('Continue', add));
    expect(add.textContent).toContain('Models from the catalog');
  });

  it('two checked catalog models are ONE addProvider call carrying both', async () => {
    addProviderFn.mockResolvedValue({
      ok: true,
      providerKey: 'anthropic-2',
      index: 4,
      models: [],
    });
    const add = await connectAnthropic();
    await click(buttonByText('Continue without testing', add));

    const boxes = add.querySelectorAll<HTMLInputElement>(
      '.add-provider-models input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    await click(boxes[0]);
    await click(boxes[1]);
    await click(buttonByText('Add provider and 2 models', add));

    expect(addProviderFn).toHaveBeenCalledTimes(1);
    expect(addProviderFn).toHaveBeenCalledWith({
      provider: 'anthropic',
      id: 'anthropic-2',
      apiKey: 'sk-ant-test',
      models: [
        { modelId: 'claude-sonnet-5', alias: 'claude-sonnet-5', contextWindow: 200_000 },
        { modelId: 'claude-haiku-4-5', alias: 'claude-haiku-4-5', contextWindow: 200_000 },
      ],
    });
    expect(document.body.querySelector('.add-provider-drawer')).toBeNull();
  });

  it('confirms a successful add with a toast naming the provider and its models', async () => {
    addProviderFn.mockResolvedValue({
      ok: true,
      providerKey: 'anthropic-2',
      index: 4,
      models: [
        { alias: 'claude-sonnet-5', providerKey: 'anthropic-2', modelId: 'claude-sonnet-5' },
        { alias: 'claude-haiku-4-5', providerKey: 'anthropic-2', modelId: 'claude-haiku-4-5' },
      ],
    });
    const add = await connectAnthropic();
    await click(buttonByText('Continue without testing', add));
    const boxes = add.querySelectorAll<HTMLInputElement>(
      '.add-provider-models input[type="checkbox"]',
    );
    await click(boxes[0]);
    await click(boxes[1]);
    await click(buttonByText('Add provider and 2 models', add));

    expect(document.body.querySelector('.ant-notification')?.textContent).toContain(
      'Added provider anthropic-2 with 2 models: claude-sonnet-5, claude-haiku-4-5.',
    );
  });

  it('confirms an add with no models, and says where to add them', async () => {
    addProviderFn.mockResolvedValue({ ok: true, providerKey: 'anthropic-2', index: 4, models: [] });
    const add = await connectAnthropic();
    await click(buttonByText('Continue without testing', add));
    await click(buttonByText('Add provider', add));

    expect(addProviderFn).toHaveBeenCalledWith(expect.objectContaining({ models: [] }));
    expect(document.body.querySelector('.ant-notification')?.textContent).toContain(
      'Added provider anthropic-2. Add models to it below.',
    );
  });

  it('takes several typed model ids, and a refusal keeps the drawer open', async () => {
    addProviderFn.mockResolvedValue({
      ok: false,
      code: 'duplicate_alias',
      message: 'The alias "sonnet" already exists.',
      problems: [],
      aliases: ['sonnet'],
    });
    const add = await connectAnthropic();
    await click(buttonByText('Continue without testing', add));
    typeInto(fieldByLabel('Another model id'), 'claude-x, claude-y');
    await click(buttonByText('Add', add));
    const alias = add.querySelector<HTMLInputElement>('input[aria-label="Alias for claude-y"]');
    expect(alias).not.toBeNull();
    typeInto(alias as HTMLInputElement, 'sonnet');
    await click(buttonByText('Add provider and 2 models', add));

    expect(addProviderFn).toHaveBeenCalledWith(
      expect.objectContaining({
        models: [
          { modelId: 'claude-x', alias: 'claude-x' },
          { modelId: 'claude-y', alias: 'sonnet' },
        ],
      }),
    );
    expect(
      drawer('add-provider-drawer').querySelector('.model-registry-refusal')?.textContent,
    ).toContain('The alias "sonnet" already exists.');
  });

  const labelsIn = (scope: Element) =>
    Array.from(scope.querySelectorAll('label')).map((l) => l.textContent?.trim());

  async function chooseType(label: string): Promise<Element> {
    mount(createElement(ModelRegistrySection));
    await click(buttonByText('Add provider'));
    const add = drawer('add-provider-drawer');
    openSelect(add);
    await chooseOption(label);
    return add;
  }

  it('azure is selectable, asks for key, base URL and API version, and adds without a test', async () => {
    addProviderFn.mockResolvedValue({ ok: true, providerKey: 'azure', index: 4, models: [] });
    const add = await chooseType('Azure OpenAI');
    expect(fieldByLabel('Id').value).toBe('azure');
    expect(labelsIn(add)).toEqual(
      expect.arrayContaining(['Type', 'Id', 'API key', 'Base URL', 'API version']),
    );
    expect(labelsIn(add)).not.toContain('Region');
    expect(labelsIn(add)).not.toContain('AWS profile');
    // validateProvider cannot test an azure entry's API version: no Test button.
    expect(
      Array.from(add.querySelectorAll('button')).some((b) => b.textContent === 'Test connection'),
    ).toBe(false);

    typeInto(fieldByLabel('API key'), 'az-key');
    expect(buttonByText('Continue without testing', add).disabled).toBe(true);
    typeInto(fieldByLabel('Base URL'), 'https://eu.openai.azure.com');
    typeInto(fieldByLabel('API version'), '2024-10-21');
    await click(buttonByText('Continue without testing', add));
    expect(add.textContent).toContain('not tested');
    await click(buttonByText('Add provider', add));

    expect(validateProviderFn).not.toHaveBeenCalled();
    expect(addProviderFn).toHaveBeenCalledWith({
      provider: 'azure',
      id: 'azure',
      apiKey: 'az-key',
      baseUrl: 'https://eu.openai.azure.com',
      apiVersion: '2024-10-21',
      models: [],
    });
  });

  it('bedrock is selectable, asks for region and AWS profile but no key or base URL', async () => {
    addProviderFn.mockResolvedValue({ ok: true, providerKey: 'bedrock', index: 4, models: [] });
    const add = await chooseType('AWS Bedrock');
    expect(fieldByLabel('Id').value).toBe('bedrock');
    expect(labelsIn(add)).toEqual(expect.arrayContaining(['Region', 'AWS profile']));
    for (const absent of ['API key', 'Base URL', 'API version']) {
      expect(labelsIn(add)).not.toContain(absent);
    }
    expect(add.textContent).toContain('providers/bedrock/accessKeyId');
    expect(
      Array.from(add.querySelectorAll('button')).some((b) => b.textContent === 'Test connection'),
    ).toBe(false);
    expect(buttonByText('Continue without testing', add).disabled).toBe(false);

    typeInto(fieldByLabel('Region'), 'us-west-2');
    typeInto(fieldByLabel('AWS profile'), 'sso-dev');
    await click(buttonByText('Continue without testing', add));
    typeInto(fieldByLabel('Another model id'), 'anthropic.claude-sonnet-5');
    await click(buttonByText('Add', add));
    await click(buttonByText('Add provider and 1 model', add));

    expect(validateProviderFn).not.toHaveBeenCalled();
    expect(addProviderFn).toHaveBeenCalledWith({
      provider: 'bedrock',
      id: 'bedrock',
      region: 'us-west-2',
      awsProfile: 'sso-dev',
      models: [{ modelId: 'anthropic.claude-sonnet-5', alias: 'anthropic-claude-sonnet-5' }],
    });
  });
});

describe('Edit provider', () => {
  it('replaces the key through updateProvider; the id is read-only', async () => {
    mount(createElement(ModelRegistrySection));
    await click(
      buttonByText(
        'Edit',
        groupFor('anthropic-work').querySelector('.settings-provider-head') as Element,
      ),
    );
    const edit = drawer('edit-provider-drawer');
    expect(fieldByLabel('Id').disabled).toBe(true);
    typeInto(fieldByLabel('API key'), 'sk-ant-new');
    await click(buttonByText('Save provider', edit));
    expect(updateProviderFn).toHaveBeenCalledWith({ key: 'anthropic-work', apiKey: 'sk-ant-new' });
  });

  function withProvider(
    key: string,
    provider: string,
    extra: Parameters<typeof providerEntry>[3] = {},
  ): ModelRegistryListResult {
    const list = registryList();
    return {
      ...list,
      providerEntries: [...list.providerEntries, providerEntry(key, 4, provider, extra)],
    };
  }

  async function openEdit(key: string): Promise<Element> {
    await click(
      buttonByText('Edit', groupFor(key).querySelector('.settings-provider-head') as Element),
    );
    return drawer('edit-provider-drawer');
  }

  const labels = (scope: Element) =>
    Array.from(scope.querySelectorAll('label')).map((l) => l.textContent?.trim());

  it('shows API version only for azure, prefilled, and sends just the changed field', async () => {
    mount(
      createElement(ModelRegistrySection),
      withProvider('azure-eu', 'azure', { apiVersion: '2024-06-01' }),
    );
    const anthropic = await openEdit('anthropic-work');
    expect(labels(anthropic)).not.toContain('API version');
    await click(buttonByText('Cancel', anthropic));

    const azure = await openEdit('azure-eu');
    expect(labels(azure)).toContain('API version');
    expect(labels(azure)).not.toContain('Region');
    expect(labels(azure)).not.toContain('AWS profile');
    expect(fieldByLabel('API version').value).toBe('2024-06-01');
    expect(azure.textContent).not.toContain("aren't shown here");
    // Prefilled and untouched is not a change.
    expect(buttonByText('Save provider', azure).disabled).toBe(true);

    typeInto(fieldByLabel('API version'), '2024-10-21');
    expect(fieldByLabel('API key').value).toBe('');
    await click(buttonByText('Save provider', azure));
    // No apiKey: a blank key keeps the stored one.
    expect(updateProviderFn).toHaveBeenCalledWith({ key: 'azure-eu', apiVersion: '2024-10-21' });
  });

  it('prefills bedrock region and profile; clearing one sends empty, which removes the line', async () => {
    mount(
      createElement(ModelRegistrySection),
      withProvider('bedrock-us', 'bedrock', {
        credential: 'not_needed',
        region: 'us-west-2',
        awsProfile: 'sso-dev',
      }),
    );
    const bedrock = await openEdit('bedrock-us');
    expect(labels(bedrock)).toEqual(expect.arrayContaining(['Region', 'AWS profile']));
    for (const absent of ['API version', 'API key', 'Base URL']) {
      expect(labels(bedrock)).not.toContain(absent);
    }
    expect(fieldByLabel('Region').value).toBe('us-west-2');
    expect(fieldByLabel('AWS profile').value).toBe('sso-dev');
    expect(bedrock.textContent).not.toContain('Saving removes this line from config.yaml.');

    typeInto(fieldByLabel('Region'), '');
    expect(bedrock.textContent).toContain('Saving removes this line from config.yaml.');
    await click(buttonByText('Save provider', bedrock));

    // Exactly these keys: no awsProfile (unchanged, kept).
    expect(updateProviderFn).toHaveBeenCalledWith({ key: 'bedrock-us', region: '' });
  });

  it('a Remove provider refusal lists the aliases that still use it', async () => {
    removeProviderFn.mockResolvedValue({
      ok: false,
      code: 'referenced',
      message: 'anthropic-work is used by 2 models. Remove or move them first.',
      problems: [],
      aliases: ['sonnet', 'opus'],
    });
    mount(createElement(ModelRegistrySection));
    await click(
      buttonByText(
        'Edit',
        groupFor('anthropic-work').querySelector('.settings-provider-head') as Element,
      ),
    );
    await click(buttonByText('Remove provider', drawer('edit-provider-drawer')));
    await click(buttonByText('Remove', modalRoot()));

    expect(removeProviderFn).toHaveBeenCalledWith({ key: 'anthropic-work' });
    const refusal = drawer('edit-provider-drawer').querySelector('.provider-refusal');
    expect(refusal?.textContent).toContain('anthropic-work is used by 2 models.');
    expect(Array.from(refusal?.querySelectorAll('li') ?? []).map((li) => li.textContent)).toEqual([
      'sonnet',
      'opus',
    ]);
  });
});

describe('Test (T2.8)', () => {
  const passed: ModelRegistryTestResult = {
    state: 'ok',
    providerKey: 'local-ollama',
    provider: 'ollama',
    modelId: 'qwen2.5-coder:32b',
    latencyMs: 42,
  };

  it('the Add-form Test works before the entry is saved', async () => {
    testFn.mockResolvedValue(passed);
    mount(createElement(ModelRegistrySection));
    await click(buttonByText('+ Add model to local-ollama', groupFor('local-ollama')));
    expect(buttonByText('Test', drawer()).disabled).toBe(true);

    typeInto(fieldByLabel('Model id'), 'qwen2.5-coder:32b');
    expect(buttonByText('Test', drawer()).disabled).toBe(false);
    await click(buttonByText('Test', drawer()));

    expect(testFn).toHaveBeenCalledWith({
      providerKey: 'local-ollama',
      modelId: 'qwen2.5-coder:32b',
    });
    expect(upsertFn).not.toHaveBeenCalled();
    expect(drawer().textContent).toContain('✓ Passed · 42 ms');
  });

  it('Test connection probes the saved provider and shows the outcome in its header', async () => {
    testProviderFn.mockResolvedValue({ ...passed, latencyMs: 312 });
    mount(createElement(ModelRegistrySection));
    const head = groupFor('local-ollama').querySelector('.settings-provider-head') as Element;
    await click(buttonByText('Test connection', head));
    expect(testProviderFn).toHaveBeenCalledWith({ providerKey: 'local-ollama' });
    expect(head.textContent).toContain('✓ 312 ms');
    expect(testButtonIn(head).textContent).toBe('Test connection · 10s');
  });

  it('the button is disabled for 10s after a test, and the handler refusal is never reached on the ordinary path', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T10:00:00.000Z'));
    testFn.mockResolvedValue({ ...passed, alias: 'sonnet', providerKey: 'anthropic-work' });
    mount(createElement(ModelRegistrySection));

    await click(testButtonIn(rowFor('sonnet')));
    expect(testFn).toHaveBeenCalledTimes(1);
    expect(testFn).toHaveBeenCalledWith({ alias: 'sonnet' });
    expect(rowFor('sonnet').textContent).toContain('✓ 42 ms');

    const cooling = testButtonIn(rowFor('sonnet'));
    expect(cooling.disabled).toBe(true);
    expect(cooling.textContent).toBe('Test · 10s');
    await click(cooling);
    expect(testFn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-13T10:00:09.500Z'));
    rerender();
    expect(testButtonIn(rowFor('sonnet')).textContent).toBe('Test · 1s');

    vi.setSystemTime(new Date('2026-09-13T10:00:10.000Z'));
    rerender();
    const ready = testButtonIn(rowFor('sonnet'));
    expect(ready.disabled).toBe(false);
    expect(ready.textContent).toBe('Test');
    // No other row's window was touched by this one.
    expect(testButtonIn(rowFor('opus')).disabled).toBe(false);
    expect(document.body.textContent).not.toContain('try again');
  });

  it('is disabled for a model whose provider has no key', () => {
    mount(createElement(ModelRegistrySection));
    expect(testButtonIn(rowFor('gpt')).disabled).toBe(true);
    expect(groupFor('openai-main').textContent).toContain('✗ no key');
  });

  it('Test all maps each outcome onto every alias of that provider entry', async () => {
    testAllFn.mockResolvedValue({
      results: [
        {
          providerKey: 'anthropic-work',
          aliases: ['opus', 'sonnet'],
          outcome: { ...passed, alias: 'opus', providerKey: 'anthropic-work', latencyMs: 300 },
        },
        {
          providerKey: 'local-ollama',
          aliases: ['qwen'],
          outcome: {
            state: 'unreachable',
            alias: 'qwen',
            providerKey: 'local-ollama',
            provider: 'ollama',
            modelId: 'qwen2.5-coder:32b',
            error: 'connect ECONNREFUSED 127.0.0.1:11434',
          },
        },
      ],
    });
    mount(createElement(ModelRegistrySection));
    await click(buttonByText('Test all'));

    expect(rowFor('sonnet').textContent).toContain('✓ 300 ms');
    expect(rowFor('opus').textContent).toContain('✓ 300 ms');
    expect(rowFor('qwen').textContent).toContain('⚠ could not reach local-ollama');
    expect(rowFor('gpt').textContent).toContain('not tested');
  });
});

describe('removal (T2.12)', () => {
  const referents: ModelReferent[] = [
    { kind: 'personality', personalityId: 'researcher-eu', field: 'model', readOnly: false },
    { kind: 'personality', personalityId: 'engineer', field: 'model.deep', readOnly: true },
    { kind: 'role', role: 'deep' },
    { kind: 'routing', personalityId: 'pr-reviewer' },
  ];

  beforeEach(() => {
    removeFn.mockImplementation(
      async (input: { alias: string; repointTo?: string; force?: boolean }) => {
        if (input.repointTo === undefined && input.force !== true) {
          return {
            ok: false,
            code: 'referenced',
            message: '"opus" is used by researcher-eu, engineer and the role binding "deep".',
            problems: [],
            referents,
          };
        }
        return {
          ok: true,
          alias: 'opus',
          repointedTo: input.repointTo ?? null,
          rewritten: input.force
            ? []
            : referents.filter((r) => r.kind !== 'personality' || !r.readOnly),
          needsAttention: input.force
            ? referents
            : referents.filter((r) => r.kind === 'personality' && r.readOnly),
        };
      },
    );
  });

  async function openDialog(): Promise<Element> {
    mount(createElement(ModelRegistrySection));
    await click(buttonByText('Remove', rowFor('opus')));
    expect(removeFn).toHaveBeenCalledWith({ alias: 'opus' });
    const dialog = document.body.querySelector('.model-remove-dialog');
    expect(dialog, 'removal dialog did not open').not.toBeNull();
    return dialog as Element;
  }

  it('removing a referenced alias lists every personality and role binding that names it', async () => {
    const dialog = await openDialog();
    const items = Array.from(dialog.querySelectorAll('li')).map((li) => li.textContent);
    expect(items).toEqual([
      'personality researcher-eu',
      'personality engineer (model.deep), built-in and read-only',
      'role deep',
      'routing for pr-reviewer',
    ]);
    expect(dialog.textContent).toContain(
      "Removing it stops those from running until they're pointed at another model.",
    );
  });

  it('"Repoint them to…" rewrites every referent in one write', async () => {
    const dialog = await openDialog();
    await click(buttonByText('Repoint them to sonnet', dialog));

    expect(removeFn).toHaveBeenLastCalledWith({ alias: 'opus', repointTo: 'sonnet' });
    expect(removeFn).toHaveBeenCalledTimes(2);
    // The built-in could not be rewritten, and the page says so.
    const notice = document.body.querySelector('.settings-models [role="status"]');
    expect(notice?.textContent).toContain('Removed opus.');
    expect(notice?.textContent).toContain(
      'personality engineer (model.deep), built-in and read-only',
    );
    expect(document.body.querySelector('.model-remove-dialog')).toBeNull();
  });

  it('"Remove anyway" leaves the referents needing attention, not silently repointed', async () => {
    const dialog = await openDialog();
    await click(buttonByText('Remove anyway', dialog));

    expect(removeFn).toHaveBeenLastCalledWith({ alias: 'opus', force: true });
    const notice = document.body.querySelector('.settings-models [role="status"]');
    for (const text of ['personality researcher-eu', 'role deep', 'routing for pr-reviewer']) {
      expect(notice?.textContent).toContain(text);
    }
  });
});

function noop() {}

/** Stands in for `SettingsShell` — see `settings-self-save-markers.test.ts`. */
function PaneHarness() {
  const [form] = Form.useForm();
  const context: SettingsPaneContext = {
    form,
    config: undefined,
    personalities: [],
    personalitiesLoading: false,
    quickCommandRows: [],
    setQuickCommandRows: noop,
    channelToolsetRows: [],
    setChannelToolsetRows: noop,
    voiceTtsProviderRows: [],
    setVoiceTtsProviderRows: noop,
    voiceSttProviderRows: [],
    setVoiceSttProviderRows: noop,
    voiceRealtimeProviderRows: [],
    setVoiceRealtimeProviderRows: noop,
    retentionRows: [],
    setRetentionRows: noop,
    voiceBotRows: [],
    setVoiceBotRows: noop,
  };
  return createElement(Form, { form, component: false }, createElement(Outlet, { context }));
}

describe('the Models pane', () => {
  it('renders one providers & models list and no page-Save provider chain table', () => {
    mount(
      createElement(
        MemoryRouter,
        null,
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(PaneHarness) },
            createElement(Route, { path: '*', element: createElement(ModelsPane) }),
          ),
        ),
      ),
    );
    expect(document.getElementById('models')?.textContent).toBe('providers & models');
    expect(document.getElementById('provider-chain')).toBeNull();
    expect(document.body.querySelector('input[aria-label="Provider entry id"]')).toBeNull();
    expect(document.body.querySelectorAll('.settings-provider-group')).toHaveLength(4);
  });
});

describe('per-personality routing (T2.7)', () => {
  const ids = ['engineer', 'pr-reviewer', 'researcher-eu'];

  it('adding a routing override writes modelRouting.<id>', async () => {
    mount(createElement(ModelRoutingSection, { personalityIds: ids }));
    await click(buttonByText('Add override'));
    const draftRow = () => {
      const rows = document.body.querySelectorAll('.settings-model-routing tr.settings-table-row');
      return rows[rows.length - 1] as Element;
    };

    openSelect(draftRow(), 0);
    // pr-reviewer already has an override, so it is not offered twice.
    expect(openOptions()).toEqual(['engineer', 'researcher-eu']);
    await chooseOption('researcher-eu');
    expect(setRoutingFn).not.toHaveBeenCalled();

    openSelect(draftRow(), 1);
    await chooseOption('opus');
    expect(setRoutingFn).toHaveBeenCalledWith({
      personalityId: 'researcher-eu',
      declaration: 'opus',
    });
  });

  it('the alias list is the registry', () => {
    mount(createElement(ModelRoutingSection, { personalityIds: ids }));
    const row = document.body.querySelector('.settings-model-routing tr.settings-table-row');
    expect(row?.textContent).toContain('deep → opus');
    openSelect(row as Element, 1);
    const groups = Array.from(document.body.querySelectorAll('.ant-select-item-group')).map(
      (el) => el.textContent,
    );
    expect(groups).toEqual(['Roles', 'Models']);
    const options = openOptions();
    const aliases = registryList().entries.map((e) => e.alias);
    expect(options).toHaveLength(4 + aliases.length);
    // Four roles, then exactly the registry's aliases, in config-file order.
    ['trivial', 'default', 'deep', 'dreaming', ...aliases].forEach((name, i) => {
      expect(options[i]?.startsWith(name), `option ${i}: ${options[i]}`).toBe(true);
    });
  });

  it('Remove deletes the modelRouting line', async () => {
    mount(createElement(ModelRoutingSection, { personalityIds: ids }));
    await click(buttonByText('Remove'));
    expect(setRoutingFn).toHaveBeenCalledWith({ personalityId: 'pr-reviewer', declaration: null });
  });
});
