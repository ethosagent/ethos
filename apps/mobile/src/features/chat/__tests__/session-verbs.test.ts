import { describe, expect, it, vi } from 'vitest';
import { runSessionVerb } from '../session-verbs';

function fakeSessions() {
  const s = {
    update: vi.fn(async () => ({ session: { id: 's1' } })),
    fork: vi.fn(async () => ({ session: { id: 's2' } })),
    delete: vi.fn(async () => ({ ok: true as const })),
    export: vi.fn(async () => ({ content: '# transcript', filename: 's1.md' })),
  };
  return { s, api: s as unknown as Parameters<typeof runSessionVerb>[0] };
}

describe('runSessionVerb', () => {
  it('rename is sessions.update with the title — there is no rename method', async () => {
    const { s, api } = fakeSessions();
    const result = await runSessionVerb(api, 'rename', { id: 's1', title: '  Deploy notes ' });
    expect(s.update).toHaveBeenCalledTimes(1);
    expect(s.update).toHaveBeenCalledWith({ id: 's1', title: 'Deploy notes' });
    expect(s.fork).not.toHaveBeenCalled();
    expect(s.delete).not.toHaveBeenCalled();
    expect(s.export).not.toHaveBeenCalled();
    expect('rename' in s).toBe(false);
    expect(result).toBeNull();
  });

  it('an empty rename clears the title', async () => {
    const { s, api } = fakeSessions();
    await runSessionVerb(api, 'rename', { id: 's1', title: '   ' });
    expect(s.update).toHaveBeenCalledWith({ id: 's1', title: null });
  });

  it("fork returns the new session's id", async () => {
    const { s, api } = fakeSessions();
    const result = await runSessionVerb(api, 'fork', { id: 's1' });
    expect(result).toBe('s2');
    expect(s.fork).toHaveBeenCalledWith({ id: 's1' });
  });

  it('delete is sessions.delete', async () => {
    const { s, api } = fakeSessions();
    const result = await runSessionVerb(api, 'delete', { id: 's1' });
    expect(s.delete).toHaveBeenCalledWith({ id: 's1' });
    expect(result).toBeNull();
  });

  it('share exports markdown and hands it to the share sheet', async () => {
    const { s, api } = fakeSessions();
    const share = vi.fn(async () => undefined);
    await runSessionVerb(api, 'share', { id: 's1', share });
    expect(s.export).toHaveBeenCalledWith({ id: 's1', format: 'markdown' });
    expect(share).toHaveBeenCalledWith('# transcript', 's1.md');
  });
});
