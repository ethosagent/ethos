import { describe, expect, it } from 'vitest';
import { DOWNGRADE_REJECTION_MESSAGE, resolveDowngradedTools } from '../downgrade';

describe('resolveDowngradedTools', () => {
  it('returns the default set for `auto`', () => {
    const tools = resolveDowngradedTools('auto');
    expect(tools.has('terminal')).toBe(true);
    expect(tools.has('write_file')).toBe(true);
    expect(tools.has('browse_url')).toBe(true);
  });

  // UBP-049: a write that persists into a later system prompt is downgraded too.
  it('covers the memory- and skill-persisting tools', () => {
    const tools = resolveDowngradedTools('auto');
    expect(tools.has('memory_write')).toBe(true);
    expect(tools.has('team_memory_write')).toBe(true);
    expect(tools.has('skill_propose')).toBe(true);
  });

  it('returns the default set for undefined (no config)', () => {
    expect(resolveDowngradedTools(undefined).has('terminal')).toBe(true);
  });

  it('returns the explicit list when provided', () => {
    const tools = resolveDowngradedTools(['only_this_tool']);
    expect(tools.has('only_this_tool')).toBe(true);
    expect(tools.has('terminal')).toBe(false);
    expect(tools.size).toBe(1);
  });

  it('returns an empty set when given an empty array', () => {
    const tools = resolveDowngradedTools([]);
    expect(tools.size).toBe(0);
  });
});

describe('DOWNGRADE_REJECTION_MESSAGE', () => {
  it('mentions the post-untrusted-read context', () => {
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/untrusted/i);
  });

  // A goal attempt never gets a user message; the old text told the model to
  // wait for one, and the goal gave up. The pause lifts after N model steps.
  it('states the automatic expiry, not a user-message requirement', () => {
    expect(DOWNGRADE_REJECTION_MESSAGE).not.toMatch(/user message/i);
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/next few model steps/i);
  });

  // V-ES-9: the memory and skill writers stay blocked for the run, and the
  // text invites no retry — an invitation turned the window into a delay.
  it('says the persistence tools stay blocked, and invites no retry', () => {
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/rest of this run/i);
    expect(DOWNGRADE_REJECTION_MESSAGE).not.toMatch(/retry|try again/i);
  });

  // V3 wording: a sub-agent of a tainted run, or the review turn of a tainted
  // background job, starts armed without reading anything itself. The text
  // must not claim this run's own tool read the content.
  it('is accurate for a run that inherited the taint', () => {
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/this run is handling untrusted content/i);
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/inherited/i);
    expect(DOWNGRADE_REJECTION_MESSAGE).not.toMatch(/tool read external content during this run/i);
  });

  it('names every run-scoped refusal the rule enforces', () => {
    for (const name of [
      'memory_write',
      'team_memory_write',
      'skill_propose',
      'cron create/update',
      'goal_create',
      'kanban_create',
      'kanban_block',
      'background delegate_task',
      'watcher_create',
      'scaffold_personality',
      'scaffold_team',
      'Ethos state dir',
    ]) {
      expect(DOWNGRADE_REJECTION_MESSAGE).toContain(name);
    }
  });

  // V4-2: in a standalone deployment a worker run that ends without closing its
  // ticket is reclaimed to `ready` and dispatched again, so a tainted worker
  // must be told how it CAN report being blocked.
  it('points a tainted worker at kanban_update_status to report a blocked ticket', () => {
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/kanban_update_status with status "blocked"/);
  });
});
