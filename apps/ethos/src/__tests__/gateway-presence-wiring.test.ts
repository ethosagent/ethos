// Plan personality-presence-and-initiative §3 — the channel-presence settings
// reach the process. Source text, the same idiom as
// `gateway-daily-budget-wiring.test.ts`: every assertion below needs a whole
// gateway process to reach at runtime.
//
// Pinned here:
//  - `buildGatewayBots` carries `replyPrefix` onto Telegram/Slack bots and the
//    legacy Discord bot (the Gateway applies it: `applyReplyPrefix`);
//  - `buildAdapters` passes `mentionByName` to all three adapters;
//  - both hosts (`ethos gateway start`, `ethos boot`) give the personality
//    directory seam an `identity()` that reads `name` and `display.emoji`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('channel presence wiring', () => {
  it('bots carry replyPrefix and adapters receive mentionByName', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    expect(src).toContain('...(bot.replyPrefix ? { replyPrefix: bot.replyPrefix } : {})');
    expect(src).toContain(
      '...(config.discord?.replyPrefix ? { replyPrefix: config.discord.replyPrefix } : {})',
    );
    expect(src).toContain(
      '...(botCfg.mentionByName !== undefined ? { mentionByName: botCfg.mentionByName } : {})',
    );
    expect(src).toContain(
      '...(appCfg.mentionByName !== undefined ? { mentionByName: appCfg.mentionByName } : {})',
    );
    expect(src).toContain('? { mentionByName: config.discord.mentionByName }');
  });

  it('both hosts expose identity() on the personality directory seam', async () => {
    for (const file of ['gateway.ts', 'boot.ts']) {
      const src = await readFile(join(ROOT, 'apps/ethos/src/commands', file), 'utf8');
      expect(src, file).toContain('identity: (id: string) => {');
      expect(src, file).toContain(
        '? { name: p.name, ...(p.display?.emoji ? { emoji: p.display.emoji } : {}) }',
      );
    }
  });
});
