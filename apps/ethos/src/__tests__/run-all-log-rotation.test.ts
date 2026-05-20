import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testing__ } from '../commands/run-all';
import { type LogRotationConfig, rotateIfNeeded } from '../error-log';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ethos-run-all-logrot-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('run-all log rotation integration', () => {
  it('exports DEFAULT_LOG_ROTATION with expected defaults', () => {
    expect(__testing__.DEFAULT_LOG_ROTATION).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 5,
      enabled: true,
    });
  });

  it('exports LOG_ROTATION_INTERVAL_MS as 60s', () => {
    expect(__testing__.LOG_ROTATION_INTERVAL_MS).toBe(60_000);
  });

  it('rotateIfNeeded rotates a child log exceeding maxBytes', () => {
    const logPath = join(tmpDir, 'gateway.log');
    const config: LogRotationConfig = { maxBytes: 512, maxFiles: 3, enabled: true };
    writeFileSync(logPath, 'x'.repeat(1024));
    rotateIfNeeded(logPath, config);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('x'.repeat(1024));
    expect(existsSync(logPath)).toBe(false);
  });

  it('rotateIfNeeded respects maxFiles cap across multiple rotations', () => {
    const logPath = join(tmpDir, 'serve.log');
    const config: LogRotationConfig = { maxBytes: 100, maxFiles: 2, enabled: true };

    writeFileSync(logPath, 'a'.repeat(200));
    rotateIfNeeded(logPath, config);

    writeFileSync(logPath, 'b'.repeat(200));
    rotateIfNeeded(logPath, config);

    writeFileSync(logPath, 'c'.repeat(200));
    rotateIfNeeded(logPath, config);

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('c'.repeat(200));
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(readFileSync(`${logPath}.2`, 'utf-8')).toBe('b'.repeat(200));
    expect(existsSync(`${logPath}.3`)).toBe(false);
  });

  it('rotateIfNeeded skips when enabled is false', () => {
    const logPath = join(tmpDir, 'gateway.log');
    const config: LogRotationConfig = { maxBytes: 100, maxFiles: 3, enabled: false };
    writeFileSync(logPath, 'x'.repeat(500));
    rotateIfNeeded(logPath, config);
    expect(existsSync(logPath)).toBe(true);
    expect(statSync(logPath).size).toBe(500);
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it('rotateIfNeeded does not throw when the file does not exist', () => {
    const logPath = join(tmpDir, 'missing.log');
    const config: LogRotationConfig = { maxBytes: 100, maxFiles: 3, enabled: true };
    expect(() => rotateIfNeeded(logPath, config)).not.toThrow();
    expect(existsSync(logPath)).toBe(false);
  });
});
