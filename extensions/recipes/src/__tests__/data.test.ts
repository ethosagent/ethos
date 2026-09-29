// Per-bundle assertions for the shipped catalog — the facts each recipe's
// header comment claims, checked rather than trusted. The table test
// (bundles.test.ts) proves every bundle parses; this proves the authored
// deviations actually landed.

import { describe, expect, it } from 'vitest';
import { heartbeat, linkArchiver, obsidianSecondBrain, RECIPES, webWatchdog } from '../data';
import { projectBundle, RecipeBundleSchema } from '../schema';
import { renderRecipe } from '../template';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
const SELF_DIR = '${ETHOS_HOME}/personalities/${self}/';
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
const SKILLS_DIR = '${ETHOS_HOME}/skills/';

describe('RECIPES', () => {
  it('ships the three usecase bundles', () => {
    const ids = RECIPES.map((r) => r.id);
    expect(ids).toContain('obsidian-second-brain');
    expect(ids).toContain('link-archiver');
    expect(ids).toContain('web-watchdog');
  });
});

describe('obsidian-second-brain', () => {
  const VAULT = { vaultPath: '/Users/you/Vault/', consolidationTime: '30 23 * * *' };

  it('is offered in both modes, with one toolset feeding both', () => {
    expect(obsidianSecondBrain.personality.mode).toBe('both');
    expect(obsidianSecondBrain.personality.toolset).toEqual(obsidianSecondBrain.requires.tools);
    expect(obsidianSecondBrain.personality.attach.toolset).toEqual(
      obsidianSecondBrain.requires.tools,
    );
    // Cross-session reading through the session tools is not something a
    // scheduled run can do; the memory files are the honest bridge.
    expect(obsidianSecondBrain.requires.tools).not.toContain('session_search');
    expect(obsidianSecondBrain.requires.tools).not.toContain('session_list_by_date');
    expect(obsidianSecondBrain.requires.tools).toContain('memory_read');
  });

  it('create view: the vault becomes the workdir, the self entries stay, and it is offline', () => {
    const resolved = renderRecipe(projectBundle(obsidianSecondBrain, 'create'), VAULT);
    const p = resolved.personality;
    if (p.mode !== 'create') throw new Error('expected a create-mode personality');
    expect(p.id).toBe('obsidian-archivist');
    expect(p.fsReach).toEqual({
      read: [SELF_DIR, SKILLS_DIR],
      write: [SELF_DIR],
      workdir: '/Users/you/Vault/',
    });
    expect(p.soulMd.startsWith('I am Archivist.')).toBe(true);
    expect(p.soulMd).toContain('/Users/you/Vault/');
    expect(p.soulMd).not.toContain('{{input.');
    // An explicit empty allow list, not the D15 default — see the header.
    expect(p.safety).toEqual({ network: { allow: [] } });
  });

  it('attach view: only the vault is added to reach, and the same rules ride in the section', () => {
    const resolved = renderRecipe(projectBundle(obsidianSecondBrain, 'attach'), VAULT);
    const p = resolved.personality;
    if (p.mode !== 'attach') throw new Error('expected an attach-mode personality');
    // Only the vault: the target keeps its own reach, and the installer appends.
    expect(p.fsReach).toEqual({ read: ['/Users/you/Vault/'], write: ['/Users/you/Vault/'] });
    expect(p.soulSection.startsWith('## Your Obsidian vault')).toBe(true);
    expect(p.soulSection).toContain('/Users/you/Vault/');
    expect(p.soulSection).not.toContain('{{input.');
    expect(p.soulSection).toContain('## Distilled by <your name>');
    // No network policy of its own — that is the target's.
    expect('safety' in p).toBe(false);
  });

  it('composes the create SOUL and the attach section from ONE rules text', () => {
    const { soulMd, attach } = obsidianSecondBrain.personality;
    const rules = attach.soulSection.replace('## Your Obsidian vault\n\n', '');
    expect(soulMd.endsWith(rules)).toBe(true);
  });

  it('distils from the memory files nightly, in-app, skipping missed runs', () => {
    const job = obsidianSecondBrain.cronJobs[0];
    expect(job?.name).toBe('vault-consolidation');
    expect(job?.prompt).toContain('memory_read');
    expect(job?.deliverTo).toBe('inApp');
    expect(job?.missedRunPolicy).toBe('skip');
    const time = obsidianSecondBrain.requires.inputs.find((i) => i.key === 'consolidationTime');
    expect(time?.default).toBe('30 23 * * *');
  });
});

describe('link-archiver', () => {
  it('needs no channel and delivers its digest in-app', () => {
    expect(linkArchiver.requires.channels).toEqual([]);
    expect(linkArchiver.cronJobs.map((j) => j.deliverTo)).toEqual(['inApp']);
  });
});

describe('web-watchdog', () => {
  it('delivers to a channel and declares the required chatTarget that needs', () => {
    expect(webWatchdog.cronJobs.map((j) => j.deliverTo)).toEqual(['channel']);
    const chatTarget = webWatchdog.requires.inputs.find((i) => i.kind === 'chatTarget');
    expect(chatTarget?.required).toBe(true);
  });
});

describe('heartbeat', () => {
  it('is in the catalog and validates against the schema', () => {
    expect(RECIPES.map((r) => r.id)).toContain('heartbeat');
    expect(RecipeBundleSchema.safeParse(heartbeat).success).toBe(true);
  });

  it('attaches to an existing personality — the check-in is that personality’s own', () => {
    expect(heartbeat.personality.mode).toBe('attach');
  });

  it('carries active hours on by default and a prompt that falls silent', () => {
    const [job] = heartbeat.cronJobs;
    expect(heartbeat.cronJobs).toHaveLength(1);
    expect(job?.activeHours).toBe('09:00-21:00');
    // `decideEscalation` (extensions/cron/src/heartbeat.ts) holds back output
    // that BEGINS with [SILENT]; the prompt must ask for exactly that.
    expect(job?.prompt).toMatch(/begin.*\[SILENT\]/i);
  });

  it('names the clock the window is read on — the server’s, the schedule’s own', () => {
    // `CronScheduler.outsideActiveHours` reads the window on the host zone,
    // the zone croner reads the schedule in; `notifications.timezone` moves
    // quiet hours only.
    const text = [...heartbeat.notes, ...heartbeat.requires.inputs.map((i) => i.help ?? '')].join(
      '\n',
    );
    expect(text).not.toMatch(/in `notifications\.timezone`/);
    expect(text).toMatch(/server.s clock/);
    // `0 */3 * * *` in 09:00-21:00 (end exclusive) fires 09, 12, 15, 18.
    expect(text).toContain('09:00, 12:00, 15:00 and 18:00');
  });

  it('keeps activeHours through templating', () => {
    const values = Object.fromEntries(
      heartbeat.requires.inputs.map((i) => [i.key, i.default ?? 'x']),
    );
    const resolved = renderRecipe(projectBundle(heartbeat, 'attach'), values);
    expect(resolved.cronJobs[0]?.activeHours).toBe('09:00-21:00');
  });
});

describe('RecipeBundleSchema — cron activeHours', () => {
  it('accepts a job without activeHours and rejects a non-string one', () => {
    const job = heartbeat.cronJobs[0];
    if (!job) throw new Error('expected a job');
    const { activeHours: _drop, ...without } = job;
    expect(RecipeBundleSchema.safeParse({ ...heartbeat, cronJobs: [without] }).success).toBe(true);
    expect(
      RecipeBundleSchema.safeParse({ ...heartbeat, cronJobs: [{ ...job, activeHours: 9 }] })
        .success,
    ).toBe(false);
  });
});
