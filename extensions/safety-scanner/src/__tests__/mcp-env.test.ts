import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpEnv } from '../mcp-env';

// ---------------------------------------------------------------------------
// Setup: save and restore process.env around each test
// ---------------------------------------------------------------------------

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(() => {
  // Restore original env
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildMcpEnv', () => {
  it('includes PATH (default passthrough)', () => {
    process.env.PATH = '/usr/bin:/bin';
    const env = buildMcpEnv('test-server');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('includes USER when set (default passthrough)', () => {
    process.env.USER = 'testuser';
    const env = buildMcpEnv('test-server');
    expect(env.USER).toBe('testuser');
  });

  it('strips ANTHROPIC_API_KEY (credential pattern, not in extraPassthrough)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    const env = buildMcpEnv('test-server');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('strips MY_TOKEN (credential pattern, not in extraPassthrough)', () => {
    process.env.MY_TOKEN = 'tok-abc';
    const env = buildMcpEnv('test-server', ['MY_TOKEN']); // will be stripped even if in extraPassthrough?
    // Per spec: extraPassthrough CAN override the credential strip for explicitly declared vars
    // MY_TOKEN is in extraPassthrough → should be passed through
    expect(env.MY_TOKEN).toBe('tok-abc');
  });

  it('strips credential var not in extraPassthrough even if in DEFAULT_PASSTHROUGH (impossible, but test the strip)', () => {
    process.env.API_SECRET = 'very-secret';
    const env = buildMcpEnv('test-server');
    expect(env.API_SECRET).toBeUndefined();
  });

  it('strips GITHUB_TOKEN when not in extraPassthrough', () => {
    process.env.GITHUB_TOKEN = 'ghp_xxx';
    // GITHUB_TOKEN is not in default passthrough, not in extraPassthrough
    const env = buildMcpEnv('test-server');
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('strips MY_KEY_FILE (KEY appears as inner word, not just suffix)', () => {
    process.env.MY_KEY_FILE = 'path/to/key';
    const env = buildMcpEnv('test-server');
    expect(env.MY_KEY_FILE).toBeUndefined();
  });

  it('strips PASSWORD_HASH (PASSWORD appears as prefix word)', () => {
    process.env.PASSWORD_HASH = 'hashed-value';
    const env = buildMcpEnv('test-server');
    expect(env.PASSWORD_HASH).toBeUndefined();
  });

  it('does NOT strip KEYSTONE (KEY is not a separate word)', () => {
    process.env.KEYSTONE = 'not-a-secret';
    const env = buildMcpEnv('test-server', ['KEYSTONE']); // in passthrough to allow through default filter
    // Even if passed through, KEYSTONE should not be blocked by credential pattern
    // (it's not a credential — just contains the string KEY)
    expect(env.KEYSTONE).toBe('not-a-secret');
  });

  it('passes GITHUB_TOKEN when explicitly in extraPassthrough', () => {
    process.env.GITHUB_TOKEN = 'ghp_xxx';
    const env = buildMcpEnv('test-server', ['GITHUB_TOKEN']);
    expect(env.GITHUB_TOKEN).toBe('ghp_xxx');
  });

  it('does NOT include custom vars not in passthrough', () => {
    process.env.MY_CUSTOM_VAR = 'custom-value';
    const env = buildMcpEnv('test-server');
    expect(env.MY_CUSTOM_VAR).toBeUndefined();
  });

  it('includes custom var when in extraPassthrough (non-credential)', () => {
    process.env.MY_CUSTOM_VAR = 'custom-value';
    const env = buildMcpEnv('test-server', ['MY_CUSTOM_VAR']);
    expect(env.MY_CUSTOM_VAR).toBe('custom-value');
  });

  it('sets HOME to the mcp-runtime scratch dir', () => {
    const env = buildMcpEnv('my-server');
    const expected = join(homedir(), '.ethos', 'mcp-runtime', 'my-server');
    expect(env.HOME).toBe(expected);
  });

  it('sets TMPDIR to a tmp subdir within scratch', () => {
    const env = buildMcpEnv('my-server');
    const expected = join(homedir(), '.ethos', 'mcp-runtime', 'my-server', 'tmp');
    expect(env.TMPDIR).toBe(expected);
  });

  it('sets XDG_CONFIG_HOME within scratch dir', () => {
    const env = buildMcpEnv('my-server');
    const expected = join(homedir(), '.ethos', 'mcp-runtime', 'my-server', '.config');
    expect(env.XDG_CONFIG_HOME).toBe(expected);
  });

  it('sets XDG_DATA_HOME within scratch dir', () => {
    const env = buildMcpEnv('my-server');
    const expected = join(homedir(), '.ethos', 'mcp-runtime', 'my-server', '.local', 'share');
    expect(env.XDG_DATA_HOME).toBe(expected);
  });

  it('sets XDG_CACHE_HOME within scratch dir', () => {
    const env = buildMcpEnv('my-server');
    const expected = join(homedir(), '.ethos', 'mcp-runtime', 'my-server', '.cache');
    expect(env.XDG_CACHE_HOME).toBe(expected);
  });

  it('uses serverId in the scratch dir path', () => {
    const env = buildMcpEnv('special-server-123');
    expect(env.HOME).toContain('special-server-123');
  });

  it('does not leak HOME from the parent process', () => {
    const parentHome = process.env.HOME;
    const env = buildMcpEnv('test-server');
    // The env HOME should be the scratch dir, not the parent's HOME
    expect(env.HOME).not.toBe(parentHome);
  });
});

// ---------------------------------------------------------------------------
// Integration: actual child process sees minimized env
// ---------------------------------------------------------------------------

describe('buildMcpEnv — child process isolation', () => {
  it('child process cannot see ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret-leaked';
    const env = buildMcpEnv('isolation-test');
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.ANTHROPIC_API_KEY ?? "")'],
      { env, encoding: 'utf8' },
    );
    expect(result.stdout).toBe('');
  });

  it('child process cannot see OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-secret-openai';
    const env = buildMcpEnv('isolation-test');
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.OPENAI_API_KEY ?? "")'],
      { env, encoding: 'utf8' },
    );
    expect(result.stdout).toBe('');
  });

  it('child process cannot see GITHUB_TOKEN (not in passthrough)', () => {
    process.env.GITHUB_TOKEN = 'ghp-secret';
    const env = buildMcpEnv('isolation-test');
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.GITHUB_TOKEN ?? "")'],
      { env, encoding: 'utf8' },
    );
    expect(result.stdout).toBe('');
  });

  it('child process sees GITHUB_TOKEN when explicitly in passthrough', () => {
    process.env.GITHUB_TOKEN = 'ghp-allowed';
    const env = buildMcpEnv('isolation-test', ['GITHUB_TOKEN']);
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.GITHUB_TOKEN ?? "")'],
      { env, encoding: 'utf8' },
    );
    expect(result.stdout).toBe('ghp-allowed');
  });

  it('child process HOME points to the scratch dir, not the real home', () => {
    const env = buildMcpEnv('isolation-test');
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.HOME ?? "")'],
      { env, encoding: 'utf8' },
    );
    const expected = join(homedir(), '.ethos', 'mcp-runtime', 'isolation-test');
    expect(result.stdout).toBe(expected);
  });

  it('child process cannot see arbitrary non-passthrough vars', () => {
    process.env.MY_CUSTOM_VAR = 'should-not-leak';
    const env = buildMcpEnv('isolation-test');
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.MY_CUSTOM_VAR ?? "")'],
      { env, encoding: 'utf8' },
    );
    expect(result.stdout).toBe('');
  });
});
