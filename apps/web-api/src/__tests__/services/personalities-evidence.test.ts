// plan personality-memory-boundary G1-8 — the web Expression draft's evidence
// (`PersonalitiesService.gatherEvidence`) never quotes a shared room: a
// stamped-shared session, or a pre-upgrade group lane key, is skipped in the
// personality's own list and in the all-sessions fallback.

import { join } from 'node:path';
import { InMemorySessionStore } from '@ethosagent/core';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import type { PrivateChatSet } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { PersonalitiesService } from '../../services/personalities.service';

const DATA = '/data';

const llm: LLMProvider = {
  name: 'mock',
  model: 'mock',
  maxContextTokens: 100_000,
  supportsCaching: false,
  supportsThinking: false,
  complete(): AsyncIterable<CompletionChunk> {
    return (async function* () {
      yield { type: 'text_delta', text: 'I speak plainly.\nRATIONALE: none' };
      yield { type: 'done', finishReason: 'end_turn' };
    })();
  },
  async countTokens() {
    return 0;
  },
};

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

async function serviceWith(
  sessions: Array<{ key: string; text: string; personalityId?: string; shared?: boolean }>,
  privateChats?: PrivateChatSet,
): Promise<PersonalitiesService> {
  const storage = new InMemoryStorage();
  const dir = join(DATA, 'personalities', 'agent');
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
  await storage.write(join(dir, 'SOUL.md'), '# Core\nI am the agent.\n\n# Expression\nPlain.\n');
  const registry = new FilePersonalityRegistry(storage, DATA);
  await registry.loadFromDirectory(join(DATA, 'personalities'));

  const store = new InMemorySessionStore();
  for (const s of sessions) {
    const session = await store.createSession({
      key: s.key,
      platform: s.key.split(':')[0] ?? 'cli',
      model: 'm',
      provider: 'p',
      personalityId: s.personalityId ?? 'agent',
      usage,
      ...(s.shared ? { metadata: { roomAudience: 'shared' } } : {}),
    });
    await store.appendMessage({ sessionId: session.id, role: 'user', content: s.text });
  }

  return new PersonalitiesService({
    personalities: registry,
    library: new SkillsLibrary({ dataDir: DATA, storage }),
    llm: async () => llm,
    sessions: store,
    ...(privateChats ? { readPrivateChats: async () => privateChats } : {}),
  });
}

describe('PersonalitiesService evidence — shared sessions (G1-8)', () => {
  it('skips a stamped session and an UNSTAMPED group lane (pre-upgrade fixture)', async () => {
    const service = await serviceWith([
      { key: 'cli:project', text: 'owner question' },
      { key: 'web:resumed', text: 'stamped room talk', shared: true },
      { key: 'telegram:bot1:-1001234567890', text: 'pre-upgrade group talk' },
    ]);
    const { evidence } = await service.proposeExpression('agent');
    expect(evidence).toContain('owner question');
    expect(evidence).not.toContain('room talk');
    expect(evidence).not.toContain('group talk');
  });

  it('the all-sessions fallback skips shared sessions too', async () => {
    const service = await serviceWith([
      { key: 'telegram:bot1:-100999', text: 'group only' },
      { key: 'cli:other', text: 'private elsewhere', personalityId: 'someone-else' },
      { key: 'slack:bot1:C123', text: 'another room', personalityId: 'someone-else' },
    ]);
    const { evidence } = await service.proposeExpression('agent');
    expect(evidence).toContain('private elsewhere');
    expect(evidence).not.toContain('group only');
    expect(evidence).not.toContain('another room');
  });

  it('a DM lane and a listed trusted room are evidence', async () => {
    const service = await serviceWith(
      [
        { key: 'telegram:bot1:4242', text: 'dm talk' },
        { key: 'telegram:bot1:-100200', text: 'trusted room talk' },
      ],
      { has: (p, c) => p === 'telegram' && c === '-100200' },
    );
    const { evidence } = await service.proposeExpression('agent');
    expect(evidence).toContain('dm talk');
    expect(evidence).toContain('trusted room talk');
  });
});
