import type { Session, StoredMessage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type BuildChunk, type BuildSourceDeps, collectBuildInputs } from '../build/sources';

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  key: `cli:${id}`,
  platform: 'cli',
  model: 'm',
  provider: 'p',
  personalityId: 'engineer',
  usage: {} as Session['usage'],
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-10T00:00:00Z'),
  ...over,
});

const msgs = (id: string, text: string): StoredMessage[] => [
  { id: `${id}-1`, sessionId: id, role: 'user', content: text } as StoredMessage,
];

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

async function drain(it: AsyncIterable<BuildChunk>): Promise<BuildChunk[]> {
  const out: BuildChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function deps(
  sessions: Session[],
  over: Partial<BuildSourceDeps> & { asked?: string[] } = {},
): BuildSourceDeps {
  return {
    memory: async (pid) => {
      over.asked?.push(pid);
      return { memory: 'Priya leads billing.', user: '' };
    },
    sessions: (_pid, _since) =>
      from(sessions.map((s) => ({ session: s, messages: msgs(s.id, `hi from ${s.id}`) }))),
    isShared: (s) => s.metadata?.roomAudience === 'shared',
    readFolder: () => from([]),
    ...over,
  };
}

const input = { personalityId: 'engineer', folders: [], watermark: null };

describe('first-build sources', () => {
  it('R10 first build skips shared and incognito sessions', async () => {
    const chunks = await drain(
      collectBuildInputs(
        deps([
          session('own'),
          session('shared', { metadata: { roomAudience: 'shared' } }),
          session('incog', { metadata: { roomAudience: 'shared', incognito: true } }),
        ]),
        input,
      ),
    );
    const refs = chunks.filter((c) => c.kind === 'session').map((c) => c.sourceRef);
    expect(refs).toEqual(['session:own']);
  });

  it("another personality's sessions are never listed", async () => {
    const asked: string[] = [];
    const chunks = await drain(
      collectBuildInputs(
        deps([session('mine'), session('theirs', { personalityId: 'coach' })], { asked }),
        input,
      ),
    );
    expect(asked).toEqual(['engineer']);
    expect(chunks.filter((c) => c.kind === 'session').map((c) => c.sourceRef)).toEqual([
      'session:mine',
    ]);
  });

  it('a folder outside fs reach is refused', async () => {
    const chunks = await drain(
      collectBuildInputs(
        deps([], {
          readFolder: (p) => {
            if (p === '/etc') throw new Error('PATH_NOT_REACHABLE: /etc');
            return from([{ path: `${p}/a.md`, text: 'Mei owns search.' }]);
          },
        }),
        { ...input, folders: ['/etc', 'notes'] },
      ),
    );
    const refused = chunks.find((c) => c.refused !== undefined);
    expect(refused?.sourceRef).toBe('file:/etc');
    expect(refused?.text).toBe('');
    expect(chunks.some((c) => c.sourceRef === 'file:notes/a.md')).toBe(true);
  });

  it('watermark: only sessions after the last build are read', async () => {
    const old = session('old', { updatedAt: new Date('2026-10-01T00:00:00Z') });
    const fresh = session('fresh', { updatedAt: new Date('2026-11-20T00:00:00Z') });
    let seenSince: string | null = 'unset';
    const chunks = await drain(
      collectBuildInputs(
        deps([old, fresh], {
          sessions: (_p, since) => {
            seenSince = since;
            return from(
              [old, fresh].map((s) => ({ session: s, messages: msgs(s.id, `hi ${s.id}`) })),
            );
          },
        }),
        { ...input, watermark: { sessionsSince: '2026-11-01T00:00:00.000Z' } },
      ),
    );
    expect(seenSince).toBe('2026-11-01T00:00:00.000Z');
    expect(chunks.filter((c) => c.kind === 'session').map((c) => c.sourceRef)).toEqual([
      'session:fresh',
    ]);
  });
});
