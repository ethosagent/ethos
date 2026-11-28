import type {
  ScopedFs,
  Session,
  StoredMessage,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorldTools } from '../index';
import { ctxFor, type ToolHarness, textOf, toolHarness } from './harness';

const PRIVATE = 'personality:engineer' as const;
const ACME = 'world:acme' as const;

const session = (id: string, updatedAt: string): Session => ({
  id,
  key: `cli:${id}`,
  platform: 'cli',
  model: 'm',
  provider: 'p',
  personalityId: 'engineer',
  usage: {} as Session['usage'],
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date(updatedAt),
});

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

interface Setup {
  memory?: string;
  sessions?: Session[];
  replies: unknown[];
}

let h: ToolHarness;
let run: (name: string, args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;

async function setup(opts: Setup): Promise<void> {
  let n = 0;
  h = await toolHarness({
    build: () => ({
      sources: {
        memory: async () => ({ memory: opts.memory ?? '', user: '' }),
        sessions: () =>
          from(
            (opts.sessions ?? []).map((s) => ({
              session: s,
              messages: [
                {
                  id: `${s.id}-m`,
                  sessionId: s.id,
                  role: 'user',
                  content: `chat ${s.id}`,
                } as StoredMessage,
              ],
            })),
          ),
        isShared: () => false,
      },
      complete: async () => ({
        text: JSON.stringify(opts.replies[Math.min(n++, opts.replies.length - 1)]),
        inputTokens: 100,
        outputTokens: 50,
      }),
      wrap: (t, s) => `<untrusted source="${s}">${t}</untrusted>`,
      price: (i, o) => (i + o) * 1e-6,
    }),
  });
  const tools = new Map(createWorldTools(h.port).map((t) => [t.name, t as Tool]));
  run = async (name, args, ctx = ctxFor()) => {
    const t = tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.execute(args, ctx);
  };
}

afterEach(() => h.dispose());

const buildIdOf = (r: ToolResult): string => /buildId: (\S+?)\./.exec(textOf(r))?.[1] ?? '';

describe('world_build', () => {
  it('estimate then run then save sure_only writes only sure facts', async () => {
    await setup({
      memory: 'Ravi and Mei are on the platform team.',
      replies: [
        {
          entities: [
            { type: 'Person', name: 'Ravi' },
            { type: 'Person', name: 'Mei' },
          ],
          attributes: [
            {
              entity: { type: 'Person', name: 'Mei' },
              key: 'title',
              value: 'Staff',
              confidence: 0.9,
            },
            {
              entity: { type: 'Person', name: 'Ravi' },
              key: 'title',
              value: 'Maybe lead',
              confidence: 0.4,
            },
          ],
        },
      ],
    });
    const e = await run('world_build', { action: 'estimate', world: 'private' });
    expect(textOf(e)).toMatch(/^Will read 1 memory file, 0 private sessions, 0 files\. About /);
    const buildId = buildIdOf(e);
    const r = await run('world_build', { action: 'run', buildId });
    expect(textOf(r)).toContain(
      "2 people, 0 links. 0 duplicates I'm unsure about, 0 conflicts with your facts.",
    );
    expect((await h.provider.export(PRIVATE)).entities).toHaveLength(0);
    const s = await run('world_build', { action: 'save', buildId, choice: 'sure_only' });
    expect(s.ok).toBe(true);
    const out = await h.provider.export(PRIVATE);
    expect(out.entities.map((x) => x.name).sort()).toEqual(['Mei', 'Ravi']);
    expect(out.attributes.map((a) => a.value)).toEqual(['Staff']);
    expect(out.attributes[0]?.author).toBe('agent');
  });

  it('save on a shared world creates one batch, writes nothing live', async () => {
    await setup({
      memory: 'Acme people.',
      replies: [
        {
          entities: [
            { type: 'Person', name: 'Ravi' },
            { type: 'Person', name: 'Mei' },
          ],
          attributes: [
            {
              entity: { type: 'Person', name: 'Mei' },
              key: 'title',
              value: 'Staff',
              confidence: 0.9,
            },
          ],
        },
      ],
    });
    const e = await run('world_build', { action: 'estimate', world: 'acme' });
    const buildId = buildIdOf(e);
    await run('world_build', { action: 'run', buildId });
    const s = await run('world_build', { action: 'save', buildId, choice: 'all' });
    expect(textOf(s)).toContain('one batch');
    expect(textOf(s)).toContain('nothing is live');
    const live = await h.provider.export(ACME);
    expect(live.entities).toHaveLength(0);
    expect(live.attributes).toHaveLength(0);
    const rows = h.store.inbox(ACME);
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((x) => x.batchId)).size).toBe(1);
  });

  it('re-run reads only what is new and never touches user facts', async () => {
    const s1 = session('s1', '2026-11-10T00:00:00Z');
    const s2 = session('s2', '2026-11-20T00:00:00Z');
    const live = [s1];
    await setup({
      sessions: live,
      replies: [
        { entities: [{ type: 'Person', name: 'Ravi' }] },
        {
          entities: [{ type: 'Person', name: 'Ana' }],
          attributes: [{ entity: { type: 'Person', name: 'Ana' }, key: 'title', value: 'VP' }],
        },
      ],
    });
    const owner = await h.service.ownerWrite(
      PRIVATE,
      [{ kind: 'entity', type: 'Person', name: 'Ana', sourceRef: 'user', author: 'user' }],
      'owner',
    );
    await h.service.ownerWrite(
      PRIVATE,
      [
        {
          kind: 'attribute',
          entityId: owner.applied[0] ?? '',
          key: 'title',
          value: 'CTO',
          sourceRef: 'user',
          author: 'user',
          confidence: 1,
        },
      ],
      'owner',
    );

    const first = buildIdOf(await run('world_build', { action: 'estimate', world: 'private' }));
    await run('world_build', { action: 'run', buildId: first });
    await run('world_build', { action: 'save', buildId: first, choice: 'all' });

    live.push(s2);
    const e2 = await run('world_build', { action: 'estimate', world: 'private' });
    expect(textOf(e2)).toContain('0 memory files, 1 private session, 0 files');
    const second = buildIdOf(e2);
    const r2 = await run('world_build', { action: 'run', buildId: second });
    expect(textOf(r2)).toContain('1 conflict with your facts');
    await run('world_build', { action: 'save', buildId: second, choice: 'all' });

    const out = await h.provider.export(PRIVATE);
    const title = out.attributes.find((a) => a.key === 'title');
    expect(title).toMatchObject({ value: 'CTO', author: 'user', validTo: null, retiredAt: null });
    expect(out.attributes.filter((a) => a.key === 'title')).toHaveLength(1);
    const pending = h.store.inbox(PRIVATE);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.conflictWith).toBe(title?.id);
  });
});

describe('world_build failures', () => {
  it('save without a staged build fails with the reason', async () => {
    await setup({ memory: 'x', replies: [{ entities: [] }] });
    const e = await run('world_build', { action: 'estimate', world: 'private' });
    const r = await run('world_build', { action: 'save', buildId: buildIdOf(e), choice: 'all' });
    expect(r).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(textOf(r)).toContain('no staged results (status estimated); run it first');
    const none = await run('world_build', { action: 'save', buildId: 'build-nope', choice: 'all' });
    expect(none.ok).toBe(false);
  });

  it('a folder outside fs reach is refused', async () => {
    await setup({ replies: [{ entities: [] }] });
    const fs = {
      listEntries: async (dir: string) => {
        if (dir.startsWith('/notes')) return [{ name: 'a.md', isDir: false }];
        throw new Error(`PATH_NOT_REACHABLE: ${dir}`);
      },
      read: async () => 'Ravi owns billing.',
    } as unknown as ScopedFs;
    const r = await run(
      'world_build',
      { action: 'estimate', world: 'private', folders: ['/etc', '/notes'] },
      ctxFor({ scopedFs: fs }),
    );
    expect(textOf(r)).toContain('Will read 0 memory files, 0 private sessions, 1 file.');
    expect(textOf(r)).toContain('Skipped: "/etc" is outside');
  });
});
