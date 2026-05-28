import { mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../agent-loop';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function collect(gen) {
  const events = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}
function makeScriptedLLM(script) {
  let step = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_messages, _tools) {
      const s = script[step++ % script.length] ?? { text: 'done' };
      if ('text' in s) {
        yield { type: 'text_delta', text: s.text };
        yield { type: 'done', finishReason: 'end_turn' };
      } else {
        const id = s.id ?? `call-${step}`;
        yield { type: 'tool_use_start', toolCallId: id, toolName: s.tool };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: JSON.stringify(s.args) };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: JSON.stringify(s.args) };
        yield { type: 'done', finishReason: 'tool_use' };
      }
    },
    async countTokens() {
      return 1;
    },
  };
}
// ---------------------------------------------------------------------------
// Minimal capability backends — file tools declare fs_reach.
// The tools use direct imports, not ctx.*, so these just pass the guard.
// ---------------------------------------------------------------------------
// tools-file consumes ctx.scopedFs (capability-resolved); the capability
// resolver builds ScopedFsImpl from `storage`, so the stale-write tests
// need a real FsStorage to see files on disk that the test fixtures
// mutate via node:fs.
const testBackends = {
  storage: new FsStorage(),
  personalityFsReach: { read: ['/'], write: ['/'] },
};
async function buildFileRegistry() {
  const { DefaultToolRegistry } = await import('../tool-registry');
  const { createFileTools } = await import('@ethosagent/tools-file');
  const tools = new DefaultToolRegistry(testBackends);
  tools.registerAll(createFileTools());
  return tools;
}
/**
 * Build a personality registry that disables injection defense so the
 * post-untrusted-read downgrade doesn't block write_file during tests.
 * The stale-write guard operates on the mtime check, not injection defense.
 */
async function buildPersonalitiesNoInjectionDefense() {
  const { DefaultPersonalityRegistry } = await import('../defaults/noop-personality');
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({
    id: 'default',
    name: 'Default',
    safety: { injectionDefense: { enabled: false } },
  });
  return personalities;
}
let testDir;
beforeEach(async () => {
  testDir = join(tmpdir(), `stale-write-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// FW-28: Stale-file detection tests
// ---------------------------------------------------------------------------
describe('FW-28: stale-write guard', () => {
  it('scenario 1: read → external mtime bump → write returns STALE_WRITE with timestamps in message', async () => {
    const filePath = join(testDir, 'target.ts');
    await writeFile(filePath, 'original content');
    const tools = await buildFileRegistry();
    const personalities = await buildPersonalitiesNoInjectionDefense();
    const llm = makeScriptedLLM([
      { tool: 'read_file', args: { path: filePath } },
      { tool: 'write_file', args: { path: filePath, content: 'new content' } },
      { text: 'done' },
    ]);
    const loop = new AgentLoop({ llm, tools, personalities, options: { workingDir: testDir } });
    const allEvents = [];
    const gen = loop.run('test stale write', { sessionKey: 'sk-stale-1' });
    for await (const ev of gen) {
      allEvents.push(ev);
      // After read_file succeeds, bump the mtime externally before write_file runs.
      if (ev.type === 'tool_end' && ev.toolName === 'read_file' && ev.ok) {
        const future = new Date(Date.now() + 2000);
        await utimes(filePath, future, future);
      }
    }
    const toolEndEvents = allEvents.filter((e) => e.type === 'tool_end');
    const writeEnd = toolEndEvents.find((e) => e.toolName === 'write_file');
    expect(writeEnd).toBeDefined();
    expect(writeEnd?.ok).toBe(false);
    expect(writeEnd?.result).toMatch(/STALE_WRITE|modified externally|re-read/i);
  });
  it('scenario 2: read → write immediately (no external change) → succeeds', async () => {
    const filePath = join(testDir, 'clean.ts');
    await writeFile(filePath, 'original content');
    const tools = await buildFileRegistry();
    const personalities = await buildPersonalitiesNoInjectionDefense();
    const llm = makeScriptedLLM([
      { tool: 'read_file', args: { path: filePath } },
      { tool: 'write_file', args: { path: filePath, content: 'updated content' } },
      { text: 'done' },
    ]);
    const loop = new AgentLoop({ llm, tools, personalities, options: { workingDir: testDir } });
    const events = await collect(loop.run('test clean write', { sessionKey: 'sk-clean' }));
    const writeEnd = events
      .filter((e) => e.type === 'tool_end')
      .find((e) => e.toolName === 'write_file');
    expect(writeEnd).toBeDefined();
    expect(writeEnd?.ok).toBe(true);
  });
  it('scenario 3: write to a fresh path with no prior read → succeeds (no false positive)', async () => {
    const filePath = join(testDir, 'fresh.ts');
    // File does NOT exist yet — agent writes it for the first time
    const tools = await buildFileRegistry();
    const personalities = await buildPersonalitiesNoInjectionDefense();
    const llm = makeScriptedLLM([
      { tool: 'write_file', args: { path: filePath, content: 'brand new' } },
      { text: 'done' },
    ]);
    const loop = new AgentLoop({ llm, tools, personalities, options: { workingDir: testDir } });
    const events = await collect(loop.run('test fresh write', { sessionKey: 'sk-fresh' }));
    const writeEnd = events
      .filter((e) => e.type === 'tool_end')
      .find((e) => e.toolName === 'write_file');
    expect(writeEnd).toBeDefined();
    expect(writeEnd?.ok).toBe(true);
  });
  it('scenario 4: STALE_WRITE → fresh read_file → write_file → succeeds', async () => {
    const filePath = join(testDir, 'recovery.ts');
    await writeFile(filePath, 'original content');
    let bumpDone = false;
    const tools = await buildFileRegistry();
    const personalities = await buildPersonalitiesNoInjectionDefense();
    // Script: read → write (will be stale) → read again → write (OK) → text
    const llm = makeScriptedLLM([
      { tool: 'read_file', args: { path: filePath } },
      { tool: 'write_file', args: { path: filePath, content: 'stale attempt' } },
      { tool: 'read_file', args: { path: filePath } },
      { tool: 'write_file', args: { path: filePath, content: 'second attempt' } },
      { text: 'done' },
    ]);
    const loop = new AgentLoop({ llm, tools, personalities, options: { workingDir: testDir } });
    const allEvents = [];
    const gen = loop.run('test recovery', { sessionKey: 'sk-recovery' });
    for await (const ev of gen) {
      allEvents.push(ev);
      if (ev.type === 'tool_end' && ev.toolName === 'read_file' && ev.ok && !bumpDone) {
        // Bump after the first read so the first write attempt is stale
        const future = new Date(Date.now() + 2000);
        await utimes(filePath, future, future);
        bumpDone = true;
      }
    }
    const toolEndEvents = allEvents.filter((e) => e.type === 'tool_end');
    const writeEnds = toolEndEvents.filter((e) => e.toolName === 'write_file');
    expect(writeEnds).toHaveLength(2);
    // First write should fail with stale error
    expect(writeEnds[0]?.ok).toBe(false);
    expect(writeEnds[0]?.result).toMatch(/STALE_WRITE|modified externally|re-read/i);
    // Second write (after re-read) should succeed
    expect(writeEnds[1]?.ok).toBe(true);
  });
  it('scenario 5: read → external delete → write returns STALE_WRITE (file disappeared)', async () => {
    const filePath = join(testDir, 'deleted.ts');
    await writeFile(filePath, 'will be deleted');
    const tools = await buildFileRegistry();
    const personalities = await buildPersonalitiesNoInjectionDefense();
    const llm = makeScriptedLLM([
      { tool: 'read_file', args: { path: filePath } },
      { tool: 'write_file', args: { path: filePath, content: 'recreated' } },
      { text: 'done' },
    ]);
    const loop = new AgentLoop({ llm, tools, personalities, options: { workingDir: testDir } });
    const allEvents = [];
    const gen = loop.run('test deleted file', { sessionKey: 'sk-deleted' });
    for await (const ev of gen) {
      allEvents.push(ev);
      if (ev.type === 'tool_end' && ev.toolName === 'read_file' && ev.ok) {
        await unlink(filePath);
      }
    }
    const writeEnd = allEvents
      .filter((e) => e.type === 'tool_end')
      .find((e) => e.toolName === 'write_file');
    expect(writeEnd).toBeDefined();
    expect(writeEnd?.ok).toBe(false);
    expect(writeEnd?.result).toMatch(/STALE_WRITE|no longer exists|re-read/i);
  });
});
