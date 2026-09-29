// plan personality-presence-and-initiative §1 — the birth ritual.
//
// - The operator's create path (`FilePersonalityRegistry.create`) writes a
//   birth marker, `learning/birth/<id>.json`, through Storage. Built-ins never
//   get one.
// - `createBirthRitualInjector` (../birth-ritual.ts) adds a TAIL section only
//   while the marker exists AND `gateRefusal` passes: a private, user-started
//   CLI or web turn. The section tells the model to answer the operator's
//   message first, then run the ritual.
// - The ritual files an IDENTITY amendment (`propose_self_amendment`,
//   target `identity`). Nothing changes on disk until the owner applies it;
//   applying it clears the marker, and the ritual never runs again.
// - The personality's own tools cannot read, write or delete the marker: it
//   lives under `learning/`, which every turn's ScopedStorage denies.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  DefaultHookRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { listAmendments } from '@ethosagent/learning-inbox';
import { noopLogger } from '@ethosagent/logger';
import {
  birthMarkerPath,
  createPersonalityRegistry,
  FilePersonalityRegistry,
  hasBirthMarker,
  writeBirthMarker,
} from '@ethosagent/personalities';
import * as storageFs from '@ethosagent/storage-fs';
import { FsStorage } from '@ethosagent/storage-fs';
import {
  createProposeSelfAmendmentTool,
  PROPOSE_SELF_AMENDMENT_TOOL,
} from '@ethosagent/tools-personality-design';
import {
  type AgentEvent,
  type AmendmentOp,
  BoundaryError,
  type CompletionChunk,
  type CompletionOptions,
  type ContextInjector,
  type LLMProvider,
  type Logger,
  type PersonalityRegistry,
  type PromptContext,
  parseToolsetYaml,
  type Storage,
  type ToolContext,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AMENDMENT_TAINT_REFUSAL,
  amendmentPersonalityLoader,
  createAmendmentIntake,
  createAmendmentService,
  retireDeletedPersonality,
} from '../amendments';
import { BIRTH_RITUAL_SKILL, createBirthRitualInjector } from '../birth-ritual';
import { shippedScopedStorageFactory } from '../build-agent-loop';
import { createTestSafety } from './helpers/wiring-test-safety';

let root: string;
let dataDir: string;
let storage: FsStorage;
let registry: FilePersonalityRegistry;
let sessions: InMemorySessionStore;
let sessionId: string;

const configOf = (id: string) =>
  readFileSync(join(dataDir, 'personalities', id, 'config.yaml'), 'utf-8');

async function createNova(): Promise<void> {
  await registry.create(
    { id: 'nova', name: 'nova', toolset: ['read_file'], soulMd: '# nova\n' },
    { birth: true },
  );
}

function promptCtx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    sessionId,
    sessionKey: 'cli:birth',
    platform: 'cli',
    model: 'mock',
    history: [],
    isDm: true,
    turnNumber: 1,
    personalityId: 'nova',
    initiator: 'user',
    roomAudience: 'private',
    ...over,
  };
}

function toolCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId,
    sessionKey: 'cli:birth',
    platform: 'cli',
    personalityId: 'nova',
    initiator: 'user',
    roomAudience: 'private',
    workingDir: root,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...over,
  } as ToolContext;
}

/** `read_file` (trusted) and `web_fetch` (untrusted output), as the real registry has them. */
function baseTools(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  for (const [name, untrusted] of [
    ['read_file', false],
    ['web_fetch', true],
  ] as const) {
    tools.register({
      name,
      description: name,
      schema: { type: 'object' },
      capabilities: {},
      ...(untrusted ? { outputIsUntrusted: true } : {}),
      execute: async () => ({ ok: true, value: '' }),
    });
  }
  return tools;
}

function injector(
  personalities: Pick<PersonalityRegistry, 'get'> = registry,
  sessionStore: InMemorySessionStore = sessions,
) {
  return createBirthRitualInjector({
    storage,
    dataDir,
    personalities,
    sessions: sessionStore,
    tools: baseTools(),
  });
}

function intake(sessionStore: InMemorySessionStore = sessions) {
  return createAmendmentIntake({
    storage,
    dataDir,
    workingDir: root,
    personalities: registry,
    tools: baseTools(),
    sessions: sessionStore,
    log: noopLogger,
  });
}

function service(over: { storage?: Storage; log?: Logger } = {}) {
  return createAmendmentService({
    storage: over.storage ?? storage,
    dataDir,
    workingDir: root,
    loadPersonalities: amendmentPersonalityLoader({ storage, dataDir }),
    tools: new DefaultToolRegistry(),
    log: over.log ?? noopLogger,
  });
}

async function fileIdentity(ops: AmendmentOp[], c: ToolContext = toolCtx()) {
  return intake().submit({ target: 'identity', ops, rationale: 'chosen at birth' }, c);
}

/** Show, then apply exactly what was shown — the CLI's review-then-approve. */
async function applyReviewed(id: string, svc = service()) {
  const review = await svc.get(id);
  return svc.apply(id, {
    actor: 'cli',
    decidedBy: 'owner',
    expectedAfterHash: review?.expectedAfterHash ?? '',
  });
}

const filedId = (r: Awaited<ReturnType<typeof fileIdentity>>) => (r.ok ? r.id : '');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ethos-birth-ritual-'));
  dataDir = join(root, '.ethos');
  storage = new FsStorage();
  registry = await createPersonalityRegistry({ storage, userPersonalitiesDir: dataDir });
  sessions = new InMemorySessionStore();
  const session = await sessions.createSession({
    key: 'cli:birth',
    platform: 'cli',
    model: 'm',
    provider: 'p',
    personalityId: 'nova',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      apiCallCount: 0,
      compactionCount: 0,
    },
  });
  sessionId = session.id;
  await sessions.appendMessage({ sessionId, role: 'user', content: 'hello' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the birth marker', () => {
  it('is written by the create path, under learning/birth/, and the new personality can file', async () => {
    await createNova();
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(true);
    expect(birthMarkerPath(dataDir, 'nova')).toBe(join(dataDir, 'learning', 'birth', 'nova.json'));
    // The ritual ends in propose_self_amendment, so the create path lists it.
    expect(registry.get('nova')?.toolset).toEqual(['read_file', PROPOSE_SELF_AMENDMENT_TOOL]);
  });

  it('is written only for a birth: another creator (a recipe install) gets none, toolset as given', async () => {
    await registry.create({
      id: 'archivist',
      name: 'Archivist',
      toolset: ['read_file'],
      soulMd: '# a\n',
    });
    expect(await hasBirthMarker(storage, dataDir, 'archivist')).toBe(false);
    expect(registry.get('archivist')?.toolset).toEqual(['read_file']);
  });

  it('never narrows an undeclared toolset: an empty one stays empty', async () => {
    await registry.create(
      { id: 'open', name: 'open', toolset: [], soulMd: '# o\n' },
      { birth: true },
    );
    expect(await hasBirthMarker(storage, dataDir, 'open')).toBe(true);
    expect(registry.get('open')?.toolset ?? []).toEqual([]);
    // It cannot file (undeclared toolset), so the ritual is never offered.
    expect(await injector().inject(promptCtx({ personalityId: 'open' }))).toBeNull();
  });

  it('is never written for a built-in personality', async () => {
    await createNova();
    const builtins = registry.list().filter((p) => registry.describe(p.id)?.builtin);
    expect(builtins.length).toBeGreaterThan(0);
    for (const p of builtins) expect(await hasBirthMarker(storage, dataDir, p.id)).toBe(false);
  });

  it("is out of reach of the personality's own tools (learning/ is denied to every turn)", async () => {
    await createNova();
    const marker = birthMarkerPath(dataDir, 'nova');
    // The widest reach a personality can declare: the whole state dir.
    const scoped = shippedScopedStorageFactory(storageFs, dataDir)(storage, {
      read: [`${dataDir}/`],
      write: [`${dataDir}/`],
    });
    await expect(scoped.read(marker)).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.exists(marker)).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.write(marker, '{}')).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.remove(marker)).rejects.toBeInstanceOf(BoundaryError);
    // The file tools' ScopedFs gets the same list (build-infrastructure.ts).
    expect(storageFs.defaultAlwaysDeny([dataDir])).toContain(join(dataDir, 'learning'));
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(true);
  });
});

describe('createBirthRitualInjector', () => {
  it("adds a tail section to a fresh personality's first CLI turn: answer first, then the ritual", async () => {
    await createNova();
    const result = await injector().inject(promptCtx());
    expect(result?.position).toBe('append');
    const content = result?.content ?? '';
    const answer = content.indexOf("answer the operator's actual message");
    const ritual = content.indexOf('start your birth ritual');
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(ritual).toBeGreaterThan(answer);
    expect(content).toContain(BIRTH_RITUAL_SKILL);
    expect(content).toContain(PROPOSE_SELF_AMENDMENT_TOOL);
    // Every create path already asks for a name (M3): the section works from
    // it, and the avatar step keeps what the personality has by default.
    expect(content).not.toMatch(/has not named you/);
    expect(content).toMatch(/confirm or change/i);
    expect(content).not.toMatch(/generated mark by default/);
    expect(content).toMatch(/keep your current avatar by default/i);
    // Byte-identical on every turn it appears.
    expect((await injector().inject(promptCtx({ turnNumber: 7 })))?.content).toBe(content);
  });

  it('is silent on a Telegram turn, a shared turn, a system turn and a background job', async () => {
    await createNova();
    for (const over of [
      { sessionKey: 'telegram:bot:chat', platform: 'telegram' },
      { roomAudience: 'shared' as const, isDm: false },
      { initiator: 'system' as const },
      { jobId: 'job-1' },
      { reviewOfJobId: 'job-1' },
      { dryRun: true },
      { agentId: 'depth:1' },
    ]) {
      expect(await injector().inject(promptCtx(over))).toBeNull();
    }
  });

  it('is silent for a built-in that holds the filing tool, even with a marker planted for its id', async () => {
    // A built-in whose toolset LISTS propose_self_amendment, so the only check
    // left to silence it is `isUserOwned` (its SOUL.md is not under
    // <dataDir>/personalities/).
    const builtinDir = join(root, 'builtin', 'sage');
    mkdirSync(builtinDir, { recursive: true });
    writeFileSync(join(builtinDir, 'config.yaml'), 'name: sage\n');
    writeFileSync(join(builtinDir, 'SOUL.md'), '# sage\n');
    writeFileSync(
      join(builtinDir, 'toolset.yaml'),
      `- read_file\n- ${PROPOSE_SELF_AMENDMENT_TOOL}\n`,
    );
    const builtins = new FilePersonalityRegistry(storage);
    await builtins.loadFromDirectory(join(root, 'builtin'));
    expect(builtins.get('sage')?.toolset).toContain(PROPOSE_SELF_AMENDMENT_TOOL);
    await writeBirthMarker(storage, dataDir, 'sage');
    expect(await injector(builtins).inject(promptCtx({ personalityId: 'sage' }))).toBeNull();

    // Control: the same definition under the user dir IS offered the ritual,
    // so the silence above is `isUserOwned`, not another check.
    const userDir = join(dataDir, 'personalities', 'sage');
    mkdirSync(userDir, { recursive: true });
    for (const f of ['config.yaml', 'SOUL.md', 'toolset.yaml']) {
      writeFileSync(join(userDir, f), readFileSync(join(builtinDir, f)));
    }
    const users = new FilePersonalityRegistry(storage);
    await users.loadFromDirectory(join(dataDir, 'personalities'));
    expect(await injector(users).inject(promptCtx({ personalityId: 'sage' }))).not.toBeNull();
  });

  it('is silent once the operator removes propose_self_amendment from the toolset', async () => {
    await createNova();
    await registry.update('nova', { toolset: ['read_file'] });
    expect(await injector().inject(promptCtx())).toBeNull();
  });

  it('files, stays silent while pending, and never runs again once applied', async () => {
    await createNova();
    const before = configOf('nova');
    const filed = await intake().submit(
      {
        target: 'identity',
        ops: [
          { op: 'set_name', value: 'Nova' },
          { op: 'set_description', value: 'Calm, curious, a little dry.' },
          { op: 'set_display_emoji', value: '🦉' },
          { op: 'set_display_avatar', value: 'generated' },
        ],
        rationale: 'What the operator chose during my birth ritual.',
      },
      toolCtx(),
    );
    expect(filed).toMatchObject({ ok: true, status: 'pending' });
    // Filed, not applied: config.yaml is untouched, and the ritual waits.
    expect(configOf('nova')).toBe(before);
    expect(await injector().inject(promptCtx())).toBeNull();
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(true);

    const id = filed.ok ? filed.id : '';
    const review = await service().get(id);
    expect(review?.file).toBe('config.yaml');
    expect(review?.expectedAfterHash).toBeTruthy();
    const applied = await service().apply(id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: review?.expectedAfterHash ?? '',
    });
    expect(applied.ok).toBe(true);

    const after = configOf('nova');
    expect(after).toContain('name: Nova\n');
    expect(after).toContain('description: Calm, curious, a little dry.\n');
    expect(after).toContain('display.emoji: 🦉\n');
    expect(after).not.toContain('display.avatar_url');
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(false);
    expect(await injector().inject(promptCtx())).toBeNull();
    // The toolset is not the identity target's file: it is unchanged.
    const toolset = readFileSync(join(dataDir, 'personalities', 'nova', 'toolset.yaml'), 'utf-8');
    expect(parseToolsetYaml(toolset)).toEqual(['read_file', PROPOSE_SELF_AMENDMENT_TOOL]);
  });
});

describe('birth ritual — taint (M1)', () => {
  it('is silent once an untrusted tool result is in the session, the same check that refuses the filing', async () => {
    await createNova();
    expect(await injector().inject(promptCtx())).not.toBeNull();
    await sessions.appendMessage({
      sessionId,
      role: 'tool_result',
      content: 'fetched page text',
      toolName: 'web_fetch',
      toolCallId: 'call-web',
    });
    expect(await injector().inject(promptCtx())).toBeNull();
    // The filing it would have asked for is refused for the same reason.
    expect(await fileIdentity([{ op: 'set_name', value: 'Nova' }])).toEqual({
      ok: false,
      reason: AMENDMENT_TAINT_REFUSAL,
    });
  });

  it('is silent when the first message carried an attachment', async () => {
    await createNova();
    await sessions.appendMessage({
      sessionId,
      role: 'user',
      content: '<attachments>\n- invoice.pdf\n</attachments>\n\nwhat is this?',
    });
    expect(await injector().inject(promptCtx())).toBeNull();
    expect(await fileIdentity([{ op: 'set_name', value: 'Nova' }])).toEqual({
      ok: false,
      reason: AMENDMENT_TAINT_REFUSAL,
    });
  });
});

describe('birth ritual — ending it (M4, L1, L2)', () => {
  it('stays silent once an identity amendment is applied, even if the marker survived the apply', async () => {
    await createNova();
    const filed = await fileIdentity([{ op: 'set_name', value: 'Nova' }]);
    expect((await applyReviewed(filedId(filed))).ok).toBe(true);
    // A crash between recording `applied` and clearing the marker: the marker
    // that survived is the ORIGINAL one, written before the filing.
    await writeBirthMarker(storage, dataDir, 'nova', () => 0);
    expect(await injector().inject(promptCtx())).toBeNull();
  });

  it('reports a successful apply as applied when clearing the marker throws, and logs it', async () => {
    await createNova();
    const filed = await fileIdentity([{ op: 'set_name', value: 'Nova' }]);
    const marker = birthMarkerPath(dataDir, 'nova');
    const failingRemove = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'remove') {
          return async (path: string) => {
            if (path === marker) throw new Error('EIO: remove failed');
            return target.remove(path);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const warn = vi.fn();
    const log = { ...noopLogger, warn } as Logger;
    const applied = await applyReviewed(filedId(filed), service({ storage: failingRemove, log }));
    expect(applied).toMatchObject({ ok: true, record: { status: 'applied' } });
    expect(configOf('nova')).toContain('name: Nova\n');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/birth marker/),
      expect.objectContaining({ personalityId: 'nova' }),
    );
    // The marker is still there, and the ritual is over anyway.
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(true);
    expect(await injector().inject(promptCtx())).toBeNull();
  });

  it('accepts confirming the identity as-is: an upload-only amendment files, applies, changes no line, and ends the ritual', async () => {
    await createNova();
    const before = configOf('nova');
    const filed = await fileIdentity([{ op: 'set_display_avatar', value: 'upload' }]);
    expect(filed).toMatchObject({ ok: true, status: 'pending' });
    const applied = await applyReviewed(filedId(filed));
    expect(applied).toMatchObject({ ok: true, record: { status: 'applied' } });
    expect(configOf('nova')).toBe(before);
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(false);
    expect(await injector().inject(promptCtx())).toBeNull();
  });

  it('files an identity amendment outside a birth too (no marker): pending until the owner applies it', async () => {
    await registry.create({ id: 'nova', name: 'nova', toolset: ['read_file'], soulMd: '# n\n' });
    await registry.update('nova', { toolset: ['read_file', PROPOSE_SELF_AMENDMENT_TOOL] });
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(false);
    const before = configOf('nova');
    const filed = await fileIdentity([{ op: 'set_name', value: 'Nova' }]);
    expect(filed).toMatchObject({ ok: true, status: 'pending' });
    expect(configOf('nova')).toBe(before);
    // No marker: nothing to offer, before or after.
    expect(await injector().inject(promptCtx())).toBeNull();
  });
});

describe('birth ritual — a deleted personality leaves nothing behind (L6)', () => {
  it('retiring a deleted personality clears its marker and declines its pending amendments', async () => {
    await createNova();
    const pending = filedId(await fileIdentity([{ op: 'set_name', value: 'Nova' }]));
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(true);
    await registry.deletePersonality('nova');

    const result = await retireDeletedPersonality({
      storage,
      dataDir,
      personalityId: 'nova',
      actor: 'web',
      decidedBy: 'owner',
    });
    expect(result).toEqual({ declined: [pending], markerCleared: true });
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(false);
    const [record] = await listAmendments(storage, dataDir, { personalityId: 'nova' });
    expect(record?.status).toBe('declined');
    expect(record?.history.at(-1)).toMatchObject({
      action: 'decline',
      actor: 'web',
      reason: 'personality deleted',
    });

    // A same-id personality created afterwards starts clean: its ritual runs,
    // and the old proposal cannot be applied to it.
    await createNova();
    expect(await injector().inject(promptCtx())).not.toBeNull();
    expect(await applyReviewed(pending)).toMatchObject({ ok: false, code: 'not_pending' });
  });

  it('touches no other personality', async () => {
    await createNova();
    await registry.create(
      { id: 'vega', name: 'vega', toolset: ['read_file'], soulMd: '# vega\n' },
      { birth: true },
    );
    const vegaFiled = filedId(
      await fileIdentity([{ op: 'set_name', value: 'Vega' }], toolCtx({ personalityId: 'vega' })),
    );
    await registry.deletePersonality('nova');
    await retireDeletedPersonality({
      storage,
      dataDir,
      personalityId: 'nova',
      actor: 'web',
      decidedBy: 'owner',
    });
    expect(await hasBirthMarker(storage, dataDir, 'vega')).toBe(true);
    const [vega] = await listAmendments(storage, dataDir, { personalityId: 'vega' });
    expect(vega).toMatchObject({ id: vegaFiled, status: 'pending' });
  });

  it('an identity amendment from a previous same-id personality does not silence the new one', async () => {
    await createNova();
    const filed = await fileIdentity([{ op: 'set_name', value: 'Nova' }]);
    expect((await applyReviewed(filedId(filed))).ok).toBe(true);
    // Deleted without the operator paths' cleanup (a hand `rm -r`), then
    // created again: the old applied record predates the new marker.
    await registry.deletePersonality('nova');
    await createNova();
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(true);
    expect(await injector().inject(promptCtx())).not.toBeNull();
  });
});

describe('birth ritual — the avatar step (M3)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("refuses 'generated' when the operator already chose an avatar, so it can never delete one", async () => {
    await createNova();
    await registry.writeAvatar('nova', PNG, 'image/png', '/api/personalities/nova/avatar');
    const withAvatar = configOf('nova');
    expect(withAvatar).toContain('display.avatar_url: /api/personalities/nova/avatar\n');
    expect(
      await fileIdentity([
        { op: 'set_name', value: 'Nova' },
        { op: 'set_display_avatar', value: 'generated' },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/already has an avatar/) });
    expect(await listAmendments(storage, dataDir)).toEqual([]);

    // Leaving the avatar op out keeps it: the applied change touches the name only.
    const filed = await fileIdentity([{ op: 'set_name', value: 'Nova' }]);
    expect((await applyReviewed(filedId(filed))).ok).toBe(true);
    expect(configOf('nova')).toContain('display.avatar_url: /api/personalities/nova/avatar\n');
    expect(await registry.readAvatar('nova')).not.toBeNull();
  });

  it("a 'generated' request filed before the operator uploads goes stale instead of deleting the upload", async () => {
    await createNova();
    const filed = await fileIdentity([
      { op: 'set_name', value: 'Nova' },
      { op: 'set_display_avatar', value: 'generated' },
    ]);
    expect(filed).toMatchObject({ ok: true, status: 'pending' });
    await registry.writeAvatar('nova', PNG, 'image/png', '/api/personalities/nova/avatar');
    const result = await applyReviewed(filedId(filed));
    expect(result.ok).toBe(false);
    expect(configOf('nova')).toContain('display.avatar_url: /api/personalities/nova/avatar\n');
    expect(await registry.readAvatar('nova')).not.toBeNull();
  });
});

describe('birth ritual — identity apply, rollback and recovery (T2)', () => {
  it('rolls an applied identity amendment back to the byte-identical prior config.yaml', async () => {
    await createNova();
    const before = configOf('nova');
    const filed = await fileIdentity([
      { op: 'set_name', value: 'Nova' },
      { op: 'set_description', value: 'Calm, curious.' },
      { op: 'set_display_emoji', value: '🦉' },
    ]);
    expect((await applyReviewed(filedId(filed))).ok).toBe(true);
    expect(configOf('nova')).not.toBe(before);
    const rolled = await service().rollback(filedId(filed), { actor: 'cli', decidedBy: 'owner' });
    expect(rolled).toMatchObject({ ok: true, record: { status: 'rolled_back' } });
    expect(configOf('nova')).toBe(before);
  });

  it('recovers an identity apply that wrote config.yaml and crashed before recording it', async () => {
    await createNova();
    const filed = await fileIdentity([{ op: 'set_name', value: 'Nova' }]);
    const id = filedId(filed);
    const load = amendmentPersonalityLoader({ storage, dataDir });
    const crashing = createAmendmentService({
      storage,
      dataDir,
      workingDir: root,
      loadPersonalities: async () => {
        const reg = await load();
        const real = reg.writeDefinitionBytes.bind(reg);
        return {
          describe: (pid) => reg.describe(pid),
          writeDefinitionBytes: async (...args) => {
            await real(...args);
            throw new Error('crash after the write');
          },
        };
      },
      tools: new DefaultToolRegistry(),
      log: noopLogger,
    });
    await expect(applyReviewed(id, crashing)).rejects.toThrow('crash after the write');
    expect(configOf('nova')).toContain('name: Nova\n');
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(true);
    expect(await service().get(id)).toMatchObject({ interruptedApply: true });

    const recovered = await service().apply(id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: 'not-needed',
    });
    expect(recovered).toMatchObject({ ok: true, record: { status: 'applied' } });
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(false);
    expect(await injector().inject(promptCtx())).toBeNull();
  });

  it('goes stale, and writes nothing, when the operator edits config.yaml after filing', async () => {
    await createNova();
    const filed = await fileIdentity([{ op: 'set_name', value: 'Nova' }]);
    await registry.update('nova', { description: 'edited by hand' });
    const edited = configOf('nova');
    const review = await service().get(filedId(filed));
    expect(review).toMatchObject({ stale: true });
    const result = await service().apply(filedId(filed), {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: review?.expectedAfterHash ?? '',
    });
    expect(result).toMatchObject({ ok: false, code: 'stale', record: { status: 'stale' } });
    expect(configOf('nova')).toBe(edited);
    expect(await hasBirthMarker(storage, dataDir, 'nova')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Through a real AgentLoop: RunOptions reach the injector's gate
// ---------------------------------------------------------------------------

function recordingLLM(systems: string[]): LLMProvider {
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: unknown,
      _t: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      systems.push(typeof opts.system === 'string' ? opts.system : JSON.stringify(opts.system));
      yield { type: 'text_delta', text: 'Here is the answer.' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // exhaust
  }
}

describe('birth ritual through the agent loop', () => {
  it('reaches the system prompt tail of a private CLI turn a person started, and no other', async () => {
    await createNova();
    const systems: string[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(createProposeSelfAmendmentTool(intake()));
    const loop = new AgentLoop({
      llm: recordingLLM(systems),
      tools,
      hooks: new DefaultHookRegistry(),
      // The store the injector's taint check reads is the loop's own.
      session: sessions,
      personalities: registry,
      injectors: [injector()],
      safety: createTestSafety(),
    });

    await drain(
      loop.run('what is 2 + 2?', {
        sessionKey: 'cli:birth',
        personalityId: 'nova',
        initiator: 'user',
        roomAudience: 'private',
      }),
    );
    await drain(
      loop.run('what is 2 + 2?', {
        sessionKey: 'telegram:bot:owner',
        personalityId: 'nova',
        initiator: 'user',
        roomAudience: 'private',
      }),
    );

    expect(systems[0]).toContain('start your birth ritual');
    // A tail section: after SOUL.md, never in the static prefix.
    expect(systems[0]?.indexOf('start your birth ritual')).toBeGreaterThan(
      systems[0]?.indexOf('# nova') ?? Number.POSITIVE_INFINITY,
    );
    expect(systems[1]).not.toContain('start your birth ritual');
  });

  it('lands after every static injector, outside the cached prefix: the prefix is byte-identical with or without it (T4)', async () => {
    await createNova();
    const staticInjector = (id: string, priority: number, text: string): ContextInjector => ({
      id,
      priority,
      inject: async () => ({ content: text }),
    });
    const systems: string[] = [];
    const tools = new DefaultToolRegistry();
    tools.register(createProposeSelfAmendmentTool(intake()));
    const loop = new AgentLoop({
      llm: recordingLLM(systems),
      tools,
      hooks: new DefaultHookRegistry(),
      session: sessions,
      personalities: registry,
      // The lowest static built-in sits at 30; one far above it too.
      injectors: [
        injector(),
        staticInjector('static-low', 30, 'STATIC SECTION AT 30'),
        staticInjector('static-high', 100, 'STATIC SECTION AT 100'),
      ],
      safety: createTestSafety(),
    });
    const turn = () =>
      drain(
        loop.run('what is 2 + 2?', {
          sessionKey: 'cli:birth',
          personalityId: 'nova',
          initiator: 'user',
          roomAudience: 'private',
        }),
      );

    await turn();
    await turn();
    const [first = '', second = ''] = systems;
    const at = first.indexOf('## Your birth');
    expect(at).toBeGreaterThan(first.indexOf('STATIC SECTION AT 30'));
    expect(first.indexOf('STATIC SECTION AT 30')).toBeGreaterThan(
      first.indexOf('STATIC SECTION AT 100'),
    );
    // The section is the tail, and the prefix before it is byte-identical turn to turn.
    expect(first.slice(at)).toBe(second.slice(second.indexOf('## Your birth')));
    expect(first.slice(0, at)).toBe(second.slice(0, second.indexOf('## Your birth')));
    expect(first.endsWith(first.slice(at))).toBe(true);

    // The ritual ends: the prompt is exactly the old prefix — nothing before
    // the section moved.
    await storage.remove(birthMarkerPath(dataDir, 'nova'));
    await turn();
    expect(systems[2]).toBe(first.slice(0, at).trim());
  });
});
