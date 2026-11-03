import { describe, expect, it } from 'vitest';
import { formatJobEventLine } from '../job-event-format';

describe('formatJobEventLine', () => {
  it('collapses whitespace and caps text rows at 300 chars', () => {
    const line = formatJobEventLine({
      id: 1,
      jobId: 'j',
      seq: 1,
      eventType: 'text',
      payload: { text: `a\n\n  b ${'x'.repeat(400)}` },
      createdAt: 0,
    });
    expect(line.startsWith('text: a b ')).toBe(true);
    expect(line.length).toBeLessThanOrEqual('text: '.length + 300);
  });

  const ev = (eventType: 'runner_log' | 'artifact_change', payload: Record<string, unknown>) => ({
    id: 1,
    jobId: 'j',
    seq: 1,
    eventType,
    payload,
    createdAt: 0,
  });

  it('renders runner_log batches from their lines, not a text field', () => {
    expect(
      formatJobEventLine(
        ev('runner_log', {
          lines: [
            { stream: 'stdout', line: 'building' },
            { stream: 'stderr', line: 'warn: x' },
            'plain',
          ],
          dropped: 2,
        }),
      ),
    ).toBe('log: building | warn: x | plain | (+2 dropped)');
    expect(formatJobEventLine(ev('runner_log', { lines: [], truncated: true }))).toBe(
      'log: (truncated)',
    );
  });

  it('caps runner_log and artifact_change lines at 300 chars', () => {
    const log = formatJobEventLine(
      ev('runner_log', { lines: [{ stream: 'stdout', line: 'y'.repeat(500) }] }),
    );
    expect(log.length).toBe('log: '.length + 300);
    expect(log.endsWith('…')).toBe(true);
    const art = formatJobEventLine(ev('artifact_change', { path: `src/${'z'.repeat(500)}` }));
    expect(art.length).toBe('artifact: '.length + 300);
  });
});
