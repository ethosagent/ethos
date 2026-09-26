// C6 (plan ux-feedback-and-config-clarity §4) — slash-command feedback:
// `/verbose <bad>` refuses and KEEPS the level; steer-loss and sink-full are
// worded for the person, not the machinery; notifications share the dim `·`
// convention.

import { describe, expect, it } from 'vitest';
import {
  buildCommandsListText,
  CLI_NOTIFICATION_PREFIX,
  STEER_DISCARDED_NOTICE,
  STEER_SINK_FULL_NOTICE,
} from '../commands/chat';
import { buildBaseRegistry } from '../lib/slash-commands';
import { applyVerbosityCommand } from '../lib/verbosity';

describe('/verbose (C6)', () => {
  it('an unknown level is refused and the current level kept', () => {
    const result = applyVerbosityCommand('potato', 'verbose');
    expect(result.refused).toBe(true);
    expect(result.level).toBe('verbose');
    expect(result.notice).toBe("✗ unknown level 'potato' · valid: quiet|default|verbose|debug");
  });

  it('a valid level sets and reports', () => {
    const result = applyVerbosityCommand('quiet', 'default');
    expect(result).toEqual({ level: 'quiet', notice: 'verbosity: quiet', refused: false });
  });

  it('no argument cycles; status reports without changing', () => {
    expect(applyVerbosityCommand('', 'default')).toEqual({
      level: 'verbose',
      notice: 'verbosity: verbose',
      refused: false,
    });
    expect(applyVerbosityCommand('status', 'debug')).toEqual({
      level: 'debug',
      notice: 'verbosity: debug',
      refused: false,
    });
  });
});

describe('steer-loss wording (C6)', () => {
  it('names what happened to the message and what to do, no steer jargon', () => {
    expect(STEER_DISCARDED_NOTICE).toBe(
      'your last message was not used — the agent finished before it could read it; send it again',
    );
    expect(STEER_SINK_FULL_NOTICE).toBe(
      'your message was not queued — the agent is not at a point where it can take it; send it again in a moment',
    );
    for (const notice of [STEER_DISCARDED_NOTICE, STEER_SINK_FULL_NOTICE]) {
      expect(notice).not.toContain('steer');
      expect(notice).not.toContain('sink');
      expect(notice).not.toContain('seam');
    }
  });
});

describe('notification convention (C6)', () => {
  it('notifications print through the same dim `·` prefix as other notices', () => {
    expect(CLI_NOTIFICATION_PREFIX).toBe('· ');
  });
});

describe('/commands — the advertised command actually lists commands', () => {
  it('renders every registry entry, with prefix tags on non-built-ins', () => {
    const registry = buildBaseRegistry();
    registry.register({
      name: 'deploy',
      description: 'Ship it',
      usage: '/deploy',
      prefix: '[skill]',
    });
    const text = buildCommandsListText(registry.getAll());
    // /help itself advertises /commands — the handler must produce output,
    // never fall through to "Unknown command".
    expect(text).toContain('/commands');
    expect(text).toContain('/help');
    expect(text).toContain('/deploy');
    expect(text).toContain('Ship it [skill]');
    expect(text.length).toBeGreaterThan(0);
  });

  it('handleSlashCommand carries a real case — never the Unknown-command fall-through', () => {
    // Same source-scan pattern as setup-non-tty.test.ts's Ink guard: the
    // handler is not exported, but the case must exist for the advertised
    // command to answer.
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', 'commands', 'chat.ts'), 'utf8');
    expect(src).toContain("case 'commands':");
  });
});
