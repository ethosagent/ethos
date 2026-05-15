import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScopedFetchImpl } from '../scoped/scoped-fetch';
import { ScopedFsImpl } from '../scoped/scoped-fs';
import { ScopedProcessImpl } from '../scoped/scoped-process';
import { ScopedSecretsImpl } from '../scoped/scoped-secrets';

describe('ScopedFetchImpl', () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    mockFetch.mockClear();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('allows exact host match', async () => {
    const sf = new ScopedFetchImpl(new Set(['api.example.com']));
    await sf.fetch('https://api.example.com/v1/data');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('rejects undeclared host', async () => {
    const sf = new ScopedFetchImpl(new Set(['api.example.com']));
    await expect(sf.fetch('https://evil.com/steal')).rejects.toThrow('HOST_NOT_ALLOWED');
  });

  it('wildcard * allows any host', async () => {
    const sf = new ScopedFetchImpl(new Set(['*']));
    await sf.fetch('https://anything.anywhere.net/path');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('subdomain wildcard *.github.com matches api.github.com', async () => {
    const sf = new ScopedFetchImpl(new Set(['*.github.com']));
    await sf.fetch('https://api.github.com/repos');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('subdomain wildcard *.github.com does not match github.com itself', async () => {
    const sf = new ScopedFetchImpl(new Set(['*.github.com']));
    await expect(sf.fetch('https://github.com/repos')).rejects.toThrow('HOST_NOT_ALLOWED');
  });

  it('subdomain wildcard does not match unrelated host', async () => {
    const sf = new ScopedFetchImpl(new Set(['*.github.com']));
    await expect(sf.fetch('https://evil-github.com')).rejects.toThrow('HOST_NOT_ALLOWED');
  });

  it('passes RequestInit through to globalThis.fetch', async () => {
    const sf = new ScopedFetchImpl(new Set(['api.example.com']));
    const init: RequestInit = { method: 'POST', body: '{}' };
    await sf.fetch('https://api.example.com/v1', init);
    expect(mockFetch).toHaveBeenCalledWith(expect.any(URL), init);
  });
});

describe('ScopedFsImpl', () => {
  const makeStorage = () => ({
    read: vi.fn(),
    write: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    mtime: vi.fn(),
    listEntries: vi.fn(),
    append: vi.fn(),
    writeAtomic: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
  });

  it('read succeeds within allowed path', async () => {
    const storage = makeStorage();
    storage.read.mockResolvedValue('hello');
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    const result = await fs.read('/data/file.txt');
    expect(result).toBe('hello');
    expect(storage.read).toHaveBeenCalledWith('/data/file.txt');
  });

  it('read throws PATH_NOT_REACHABLE outside allowed path', async () => {
    const storage = makeStorage();
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    await expect(fs.read('/etc/passwd')).rejects.toThrow('PATH_NOT_REACHABLE');
  });

  it('read throws File not found when storage returns null', async () => {
    const storage = makeStorage();
    storage.read.mockResolvedValue(null);
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    await expect(fs.read('/data/missing.txt')).rejects.toThrow('File not found');
  });

  it('write succeeds within allowed write path', async () => {
    const storage = makeStorage();
    storage.write.mockResolvedValue(undefined);
    const fs = new ScopedFsImpl(storage, new Set([]), new Set(['/out']));
    await fs.write('/out/result.txt', 'content');
    expect(storage.write).toHaveBeenCalledWith('/out/result.txt', 'content');
  });

  it('write throws PATH_NOT_REACHABLE outside allowed write path', async () => {
    const storage = makeStorage();
    const fs = new ScopedFsImpl(storage, new Set([]), new Set(['/out']));
    await expect(fs.write('/secret/key', 'bad')).rejects.toThrow('PATH_NOT_REACHABLE');
  });

  it('write converts Buffer to Uint8Array', async () => {
    const storage = makeStorage();
    storage.write.mockResolvedValue(undefined);
    const fs = new ScopedFsImpl(storage, new Set([]), new Set(['/out']));
    const buf = Buffer.from('binary');
    await fs.write('/out/file.bin', buf);
    expect(storage.write).toHaveBeenCalledWith('/out/file.bin', expect.any(Uint8Array));
  });

  it('exists succeeds within allowed read path', async () => {
    const storage = makeStorage();
    storage.exists.mockResolvedValue(true);
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    const result = await fs.exists('/data/file.txt');
    expect(result).toBe(true);
  });

  it('exists throws PATH_NOT_REACHABLE outside allowed read path', async () => {
    const storage = makeStorage();
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    await expect(fs.exists('/etc/shadow')).rejects.toThrow('PATH_NOT_REACHABLE');
  });

  it('list succeeds within allowed read path', async () => {
    const storage = makeStorage();
    storage.list.mockResolvedValue(['a.txt', 'b.txt']);
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    const result = await fs.list('/data/subdir');
    expect(result).toEqual(['a.txt', 'b.txt']);
  });

  it('list throws PATH_NOT_REACHABLE outside allowed read path', async () => {
    const storage = makeStorage();
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    await expect(fs.list('/tmp')).rejects.toThrow('PATH_NOT_REACHABLE');
  });

  it('exact path match (not just prefix) is allowed', async () => {
    const storage = makeStorage();
    storage.read.mockResolvedValue('content');
    const fs = new ScopedFsImpl(storage, new Set(['/data/specific.txt']), new Set([]));
    const result = await fs.read('/data/specific.txt');
    expect(result).toBe('content');
  });
});

describe('ScopedSecretsImpl', () => {
  it('resolves a declared secret via backend', async () => {
    const backend = vi.fn().mockResolvedValue('s3cr3t');
    const secrets = new ScopedSecretsImpl(new Set(['API_KEY']), backend);
    const value = await secrets.get('API_KEY');
    expect(value).toBe('s3cr3t');
    expect(backend).toHaveBeenCalledWith('API_KEY');
  });

  it('throws SECRET_NOT_DECLARED for undeclared ref', async () => {
    const backend = vi.fn();
    const secrets = new ScopedSecretsImpl(new Set(['API_KEY']), backend);
    await expect(secrets.get('DB_PASSWORD')).rejects.toThrow('SECRET_NOT_DECLARED');
    expect(backend).not.toHaveBeenCalled();
  });

  it('passes through backend errors', async () => {
    const backend = vi.fn().mockRejectedValue(new Error('vault down'));
    const secrets = new ScopedSecretsImpl(new Set(['API_KEY']), backend);
    await expect(secrets.get('API_KEY')).rejects.toThrow('vault down');
  });
});

describe('ScopedProcessImpl', () => {
  it('executes allowed binary', async () => {
    const proc = new ScopedProcessImpl(new Set(['echo']));
    const result = await proc.spawn('echo', ['hello']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('rejects disallowed binary', async () => {
    const proc = new ScopedProcessImpl(new Set(['echo']));
    await expect(proc.spawn('rm', ['-rf', '/'])).rejects.toThrow('BINARY_NOT_ALLOWED');
  });

  it('wildcard * allows any binary', async () => {
    const proc = new ScopedProcessImpl(new Set(['*']));
    const result = await proc.spawn('echo', ['wildcard']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('wildcard');
  });

  it('captures stderr', async () => {
    const proc = new ScopedProcessImpl(new Set(['sh']));
    const result = await proc.spawn('sh', ['-c', 'echo err >&2']);
    expect(result.stderr.trim()).toBe('err');
  });

  it('reports non-zero exit code', async () => {
    const proc = new ScopedProcessImpl(new Set(['sh']));
    const result = await proc.spawn('sh', ['-c', 'exit 42']);
    expect(result.exitCode).toBe(42);
  });
});
