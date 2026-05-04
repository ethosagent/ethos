import { describe, expect, it } from 'vitest';
import { startPruneCron } from '../prune-cron';

describe('startPruneCron', () => {
  it('returns a stop function without throwing', () => {
    // Use a non-firing schedule for the test
    const handle = startPruneCron({
      obsDbPath: '/tmp/nonexistent.db',
      schedule: '0 3 * * *',
    });
    expect(handle.stop).toBeTypeOf('function');
    handle.stop();
  });
});
