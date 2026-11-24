// plan laptop-tool-node T8 (compose half), D12, D18, S1: `nodes.enabled` registers the six node
// proxies from the LIVE base tools, `buildPersonalityToolExclude` hides them from every personality
// whose toolset does not list them, and tool definitions never depend on connection state.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DefaultToolRegistry } from '@ethosagent/core';
import type { PersonalityConfig, ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';
import { NODE_TOOL_NAMES, processNodeHub, resetProcessNodeHubForTests } from '../nodes';

type Runtime = Awaited<ReturnType<typeof createAgentLoop>>;

const HANDS_TOOLSET = [...NODE_TOOL_NAMES, 'read_file'];

function writePersonality(dataDir: string, id: string, toolset: string[] | null): void {
  const dir = join(dataDir, 'personalities', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), `name: ${id}\n`);
  writeFileSync(join(dir, 'SOUL.md'), `# Core\nI am ${id}.\n`);
  if (toolset) writeFileSync(join(dir, 'toolset.yaml'), toolset.map((t) => `- ${t}\n`).join(''));
}

function excludeOf(rt: Runtime, person: PersonalityConfig): string[] {
  const fn = Reflect.get(rt.loop, 'personalityToolExclude') as (p: PersonalityConfig) => string[];
  return fn(person);
}

/** What the loop shows the model for this personality (toolset gate + surface exclusion). */
function definitionsFor(rt: Runtime, id: string): string {
  const person = rt.personalities.get(id);
  if (!person) throw new Error(`personality ${id} not loaded`);
  return JSON.stringify(
    rt.toolRegistry.toDefinitions(person.toolset, { excludeTools: excludeOf(rt, person) }),
  );
}

function names(json: string): string[] {
  return (JSON.parse(json) as Array<{ name: string }>).map((d) => d.name);
}

function ctx(home: string): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'cli:node-test',
    platform: 'cli',
    personalityId: 'plain',
    initiator: 'user',
    roomAudience: 'private',
    workingDir: home,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  } as ToolContext;
}

describe('compose-tools node proxies', () => {
  let home: string;
  let dataDir: string;
  let off: Runtime;
  let on: Runtime;
  let offDefs: { hands: string; plain: string; open: string };
  let registry: DefaultToolRegistry;
  const prevEnv: Record<string, string | undefined> = {};

  async function build(nodes: WiringConfig['nodes']): Promise<Runtime> {
    return createAgentLoop(
      {
        provider: 'ollama',
        model: 'offline-test',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'sk-dummy',
        personality: 'plain',
        memory: 'markdown',
        ...(nodes ? { nodes } : {}),
      },
      { dataDir, workingDir: home, disableDocker: true, profile: 'cli' },
    );
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ethos-compose-node-'));
    dataDir = join(home, '.ethos');
    writePersonality(dataDir, 'hands', HANDS_TOOLSET);
    writePersonality(dataDir, 'plain', ['read_file']);
    writePersonality(dataDir, 'open', null);
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    resetProcessNodeHubForTests();
    off = await build(undefined);
    offDefs = {
      hands: definitionsFor(off, 'hands'),
      plain: definitionsFor(off, 'plain'),
      open: definitionsFor(off, 'open'),
    };
    const offHasNode = off.toolRegistry.getAvailable().some((t) => t.name.startsWith('node_'));
    await off.dispose();
    expect(offHasNode).toBe(false);
    on = await build({ enabled: true });
    registry = on.toolRegistry;
  }, 180_000);

  afterAll(async () => {
    await on?.dispose();
    resetProcessNodeHubForTests();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('nodes absent: no node_* tool is registered at all', () => {
    expect(names(offDefs.hands).filter((n) => n.startsWith('node_'))).toEqual([]);
  });

  it('nodes.enabled: true registers exactly the six node tools', () => {
    const node = registry
      .getAvailable()
      .map((t) => t.name)
      .filter((n) => n.startsWith('node_'))
      .sort();
    expect(node).toEqual([...NODE_TOOL_NAMES]);
  });

  it('a personality that lists them sees all six', () => {
    expect(
      names(definitionsFor(on, 'hands'))
        .filter((n) => n.startsWith('node_'))
        .sort(),
    ).toEqual([...NODE_TOOL_NAMES]);
  });

  it('a personality without toolset.yaml sees none, byte-identical to the disabled run', () => {
    const defs = definitionsFor(on, 'open');
    expect(names(defs).filter((n) => n.startsWith('node_'))).toEqual([]);
    expect(defs).toBe(offDefs.open);
    expect(definitionsFor(on, 'plain')).toBe(offDefs.plain);
  });

  it('definitions are byte-identical before and after a node attaches (D12)', () => {
    const before = definitionsFor(on, 'hands');
    const hub = processNodeHub();
    hub.attach(
      'key-1',
      {
        v: 1,
        kind: 'hello',
        name: 'laptop',
        roots: [{ path: '/tmp/x', readOnly: false }],
        tools: ['read_file'],
        personalities: ['*'],
        clock: Date.now(),
      },
      { send: () => {}, close: () => {} },
    );
    expect(hub.list()).toHaveLength(1);
    expect(definitionsFor(on, 'hands')).toBe(before);
  });

  it('executing node_read_file as a toolset-less-of-it personality is not permitted (S1)', async () => {
    const [res] = await registry.executeParallel(
      [{ toolCallId: 'c1', name: 'node_read_file', args: { path: 'a.txt' } }],
      ctx(home),
      ['read_file'],
    );
    expect(res?.result.ok).toBe(false);
    expect(res?.result.ok === false && res.result.error).toContain(
      'is not permitted for this personality',
    );
  });

  it('executing node_read_file as the open personality is excluded', async () => {
    const open = on.personalities.get('open');
    if (!open) throw new Error('open not loaded');
    const [res] = await registry.executeParallel(
      [{ toolCallId: 'c2', name: 'node_read_file', args: { path: 'a.txt' } }],
      ctx(home),
      open.toolset,
      { excludeTools: excludeOf(on, open) },
    );
    expect(res?.result.ok === false && res.result.error).toContain('not available on this surface');
  });

  it("the proxy schema is the live read_file schema minus 'ref' plus 'node' (drift pin, plan §10)", () => {
    const base = registry.get('read_file');
    const proxy = registry.get('node_read_file');
    if (!base || !proxy) throw new Error('tools missing');
    const { ref: _ref, ...props } = base.schema.properties as Record<string, unknown>;
    expect(Object.keys(proxy.schema.properties as object).sort()).toEqual(
      [...Object.keys(props), 'node'].sort(),
    );
    for (const k of Object.keys(props)) {
      expect((proxy.schema.properties as Record<string, unknown>)[k]).toEqual(props[k]);
    }
    expect({ ...proxy.schema, properties: base.schema.properties }).toEqual(base.schema);
  });
});
