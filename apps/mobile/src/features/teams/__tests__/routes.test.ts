import { describe, expect, it } from 'vitest';
import { redirectSystemPath } from '../../../../app/+native-intent';
import { taskPath } from '../routes';

describe('team routes', () => {
  it('encodes each segment', () => {
    expect(taskPath('marketing', 'MKT/38')).toBe('/teams/marketing/task/MKT%2F38');
  });
  it('a task OS link lands on the task, not Activity', () => {
    expect(redirectSystemPath({ path: 'ethos://t/marketing/task/MKT-38', initial: true })).toBe(
      '/teams/marketing/task/MKT-38',
    );
  });
});
