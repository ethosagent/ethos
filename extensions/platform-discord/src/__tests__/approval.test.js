import { describe, expect, it } from 'vitest';
import {
  APPROVE_CUSTOM_ID_PREFIX,
  approvalPendingButtons,
  approvalPendingEmbed,
  approvalResolvedEmbed,
  DENY_CUSTOM_ID_PREFIX,
} from '../blocks/approval';

describe('blocks/approval', () => {
  it('pending embed shows tool name', () => {
    const embed = approvalPendingEmbed({
      approvalId: 'abc123',
      toolName: 'bash',
      reason: 'Destructive operation',
      args: { command: 'rm -rf /' },
    });
    expect(embed.title).toBe('Approval Required');
    expect(embed.description).toContain('bash');
    expect(embed.description).toContain('Destructive operation');
  });
  it('pending embed handles null reason', () => {
    const embed = approvalPendingEmbed({
      approvalId: 'abc123',
      toolName: 'bash',
      reason: null,
      args: {},
    });
    expect(embed.description).toContain('bash');
    expect(embed.description).not.toContain('Why');
  });
  it('pending buttons encode approvalId in customId', () => {
    const row = approvalPendingButtons('req-456');
    expect(row.components).toHaveLength(2);
    expect(row.components[0].custom_id).toBe(`${APPROVE_CUSTOM_ID_PREFIX}req-456`);
    expect(row.components[1].custom_id).toBe(`${DENY_CUSTOM_ID_PREFIX}req-456`);
  });
  it('custom_id stays within 100-char limit', () => {
    const longId = 'x'.repeat(80);
    const row = approvalPendingButtons(longId);
    for (const btn of row.components) {
      expect(btn.custom_id.length).toBeLessThanOrEqual(100);
    }
  });
  it('resolved embed shows decision', () => {
    const embed = approvalResolvedEmbed({
      toolName: 'bash',
      decision: 'allow',
      decidedBy: 'user123',
    });
    expect(embed.title).toBe('Approved');
    expect(embed.description).toContain('bash');
    expect(embed.description).toContain('user123');
  });
  it('resolved embed shows deny decision', () => {
    const embed = approvalResolvedEmbed({
      toolName: 'bash',
      decision: 'deny',
      decidedBy: 'admin',
    });
    expect(embed.title).toBe('Denied');
  });
  it('pending embed neutralizes code fence breakout in args', () => {
    const embed = approvalPendingEmbed({
      approvalId: 'test',
      toolName: 'eval',
      reason: null,
      args: '```malicious```',
    });
    // The triple backticks in args should not close the code fence
    expect(embed.description).not.toContain('```malicious```');
  });
});
