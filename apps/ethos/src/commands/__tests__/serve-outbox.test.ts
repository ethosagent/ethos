// The approval outbox under `ethos serve` (plan/phases/trust-before-reach.md,
// Part 2). `serve` holds no adapters, so it gets the proposal side only
// (`createOutboxProposalSide`): the gate and the reviewer, no dispatcher, no
// card. Delivery stays in the gateway process.
//
// `runServe` never returns while healthy, so this drives the REAL composition
// root with the options serve builds (`serveLoopOptions`) and the roster serve
// reads (`buildBotSpeakers`), then calls the loop's own `send_message`. HOME and
// ETHOS_STATE_DIR point at a temp dir and the provider is offline. That the
// source actually passes this into every serve loop with watcher tools is
// pinned by `../../__tests__/outbox-gate-live.test.ts`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { SQLiteOutboxStore } from '@ethosagent/outbox';
import type { ToolContext } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TARGET = '-100200300';
const DRAFT = 'Release notes are up.\n\n  Indented line, trailing space ';

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-serve-outbox-'));
  dataDir = join(home, '.ethos');
  for (const [id, yaml] of [
    ['writer', 'name: Writer\noutbound_policy.approve_before_send: true\n'],
    ['plain', 'name: Plain\n'],
  ] as const) {
    mkdirSync(join(dataDir, 'personalities', id), { recursive: true });
    writeFileSync(join(dataDir, 'personalities', id, 'config.yaml'), yaml);
  }
  // The operator allowlist is checked BEFORE the gate, so both need the target.
  writeFileSync(
    join(dataDir, 'messaging.json'),
    JSON.stringify({ writer: [`telegram:${TARGET}`], plain: [`telegram:${TARGET}`] }),
  );
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function ctx(personalityId: string): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'web:session-1',
    platform: 'web',
    workingDir: home,
    personalityId,
    memoryScopeId: `personality:${personalityId}`,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 20_000,
  };
}

describe('ethos serve — a gated send_message queues and does not send', () => {
  it('creates an outbox item for a gated personality, and sends an ungated one as before', async () => {
    const { createAgentLoop } = await import('@ethosagent/wiring');
    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const { serveLoopOptions } = await import('../serve');
    const { buildBotSpeakers } = await import('../gateway');
    const { createOutboxProposalSide } = await import('../../lib/outbox-wiring');

    const config = {
      personality: 'writer',
      telegram: {
        bots: [
          { id: 'example-bot', token: 't-example', bind: { type: 'personality', name: 'writer' } },
          { id: 'plain-bot', token: 't-plain', bind: { type: 'personality', name: 'plain' } },
        ],
      },
    } as EthosConfig;
    const { FsStorage } = await import('@ethosagent/storage-fs');
    const personalities = await createPersonalityRegistry({
      storage: new FsStorage(),
      userPersonalitiesDir: dataDir,
    });
    await personalities.loadFromDirectory(join(dataDir, 'personalities'));

    const side = createOutboxProposalSide({
      speakers: buildBotSpeakers(config),
      ownerTarget: () => undefined,
      personalities,
      loop: () => undefined,
      store: new SQLiteOutboxStore(':memory:'),
    });
    const options = serveLoopOptions({ meshName: 'default', outbox: side.wiring });
    expect(options.outbox).toBe(side.wiring);

    const runtime = await createAgentLoop(
      {
        provider: 'ollama',
        model: 'offline-test',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'sk-dummy',
      },
      {
        profile: options.profile,
        ...(options.outbox ? { outbox: options.outbox } : {}),
        dataDir,
        workingDir: home,
        disableDocker: true,
      },
    );
    try {
      // Stand in for a send path, so "not sent" is observed rather than
      // inferred from serve's default "Gateway not active" error.
      const send = vi.fn(async () => ({ ok: true }));
      runtime.setMessagingSend(send);
      const tool = runtime.toolRegistry.get('send_message');
      if (!tool) throw new Error('send_message is not registered');

      const gated = await tool.execute(
        { platform: 'telegram', target: TARGET, body: DRAFT },
        ctx('writer'),
      );
      expect(gated.ok).toBe(true);
      expect(gated.ok && gated.value).toContain('NOT sent');
      expect(send).not.toHaveBeenCalled();

      const items = side.service.listByPersonality('writer');
      expect(items).toHaveLength(1);
      const item = items[0];
      if (!item) throw new Error('no item');
      expect(item).toMatchObject({
        state: 'awaiting_approval',
        botKey: 'example-bot',
        platform: 'telegram',
        chatId: TARGET,
      });
      expect(side.service.getRevision(item.id, 1)?.text).toBe(DRAFT);

      // Control: the gate is the personality's policy, not the surface.
      const ungated = await tool.execute(
        { platform: 'telegram', target: TARGET, body: 'hello' },
        ctx('plain'),
      );
      expect(ungated.ok).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(side.service.listByPersonality('plain')).toHaveLength(0);
    } finally {
      await runtime.dispose();
      await side.drain();
      side.close();
    }
  }, 60_000);
});
