import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ethosDir } from '../config';

describe('ethosDir', () => {
  afterEach(() => {
    delete process.env.ETHOS_STATE_DIR;
  });
  it('returns ~/.ethos when ETHOS_STATE_DIR is not set', () => {
    delete process.env.ETHOS_STATE_DIR;
    expect(ethosDir()).toBe(join(homedir(), '.ethos'));
  });
  it('returns ETHOS_STATE_DIR when set', () => {
    process.env.ETHOS_STATE_DIR = '/tmp/custom-ethos';
    expect(ethosDir()).toBe('/tmp/custom-ethos');
  });
});
