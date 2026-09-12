import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { describe, expect, it } from 'vitest';
import { createPendingLoop } from '../../../lib/pending-loop';
import { DebugService } from '../service';

// Onboarding runs every service on the pending stand-in, which exposes
// `completeDirect` (it throws NOT_CONFIGURED until a loop is bound). The old
// `typeof completeDirect !== 'function'` guard therefore never fired, and the
// debug panel answered "Error: The agent is not running yet." instead of the
// setup message.

describe('DebugService before the agent loop exists', () => {
  it('answers with the setup message, not an error', async () => {
    const sessions = new SQLiteSessionStore(':memory:');
    const debug = new DebugService({
      sessionStore: sessions,
      agentLoop: createPendingLoop({ bound: () => undefined }),
    });
    const out = await debug.chat({ mainSessionId: 's1', message: 'hi' });
    expect(out.response).toBe('Setup required — complete onboarding first.');
    sessions.close();
  });
});
