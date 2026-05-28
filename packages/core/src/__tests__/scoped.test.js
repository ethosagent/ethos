import { describe, expect, it, vi } from 'vitest';
import { ScopedFetchImpl } from '../scoped/scoped-fetch';
import { ScopedFsImpl } from '../scoped/scoped-fs';
import { ScopedProcessImpl } from '../scoped/scoped-process';
import { ScopedSecretsImpl } from '../scoped/scoped-secrets';

describe('ScopedFetchImpl', () => {
  const makeSeam = (responseBody = 'ok', resolved = ['1.1.1.1']) => ({
    fetchImpl: vi.fn().mockResolvedValue(new Response(responseBody)),
    resolveHost: vi.fn().mockResolvedValue(resolved),
  });
  // Open personality policy — empty `allow` means no allowlist mode
  // (deny rules + private/cloud-metadata floor still apply). Lets test
  // failures isolate to the declared-allowlist layer; the
  // non-overridable safety floor stays in force regardless.
  const PERMISSIVE = { allow: [], allow_private_urls: true };
  it('allows exact host match', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['api.example.com']), PERMISSIVE, seam);
    await sf.fetch('https://api.example.com/v1/data');
    expect(seam.fetchImpl).toHaveBeenCalledOnce();
  });
  it('rejects undeclared host', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['api.example.com']), PERMISSIVE, seam);
    await expect(sf.fetch('https://evil.com/steal')).rejects.toThrow('HOST_NOT_ALLOWED');
    expect(seam.fetchImpl).not.toHaveBeenCalled();
  });
  it('wildcard * allows any host', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['*']), PERMISSIVE, seam);
    await sf.fetch('https://anything.anywhere.net/path');
    expect(seam.fetchImpl).toHaveBeenCalledOnce();
  });
  it('subdomain wildcard *.github.com matches api.github.com', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['*.github.com']), PERMISSIVE, seam);
    await sf.fetch('https://api.github.com/repos');
    expect(seam.fetchImpl).toHaveBeenCalledOnce();
  });
  it('subdomain wildcard *.github.com does not match github.com itself', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['*.github.com']), PERMISSIVE, seam);
    await expect(sf.fetch('https://github.com/repos')).rejects.toThrow('HOST_NOT_ALLOWED');
  });
  it('subdomain wildcard does not match unrelated host', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['*.github.com']), PERMISSIVE, seam);
    await expect(sf.fetch('https://evil-github.com')).rejects.toThrow('HOST_NOT_ALLOWED');
  });
  it('passes RequestInit through to the underlying fetch', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['api.example.com']), PERMISSIVE, seam);
    const init = { method: 'POST', body: '{}' };
    await sf.fetch('https://api.example.com/v1', init);
    // safeFetch forces redirect: 'manual'; the rest of init passes through.
    expect(seam.fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/v1',
      expect.objectContaining({ method: 'POST', body: '{}', redirect: 'manual' }),
    );
  });
  // Gap-1 floor checks: a tool declaring '*' against a permissive personality
  // STILL hits the non-overridable safety floor for cloud-metadata IPs and
  // bad schemes. The fetch must never be issued.
  it('floor blocks cloud-metadata IP literal even with allowedHosts=[*]', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['*']), PERMISSIVE, seam);
    await expect(sf.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      'HOST_NOT_ALLOWED',
    );
    expect(seam.fetchImpl).not.toHaveBeenCalled();
  });
  it('floor blocks DNS-resolves-to-cloud-metadata even with allowedHosts=[*]', async () => {
    const seam = makeSeam('ok', ['169.254.169.254']);
    const sf = new ScopedFetchImpl(new Set(['*']), PERMISSIVE, seam);
    await expect(sf.fetch('http://attacker.example.com/')).rejects.toThrow('HOST_NOT_ALLOWED');
    expect(seam.fetchImpl).not.toHaveBeenCalled();
  });
  it('floor blocks file:// scheme even with allowedHosts=[*]', async () => {
    const seam = makeSeam();
    const sf = new ScopedFetchImpl(new Set(['*']), PERMISSIVE, seam);
    await expect(sf.fetch('file:///etc/passwd')).rejects.toThrow('HOST_NOT_ALLOWED');
    expect(seam.fetchImpl).not.toHaveBeenCalled();
  });
  it('floor blocks private-network resolution when allow_private_urls is false', async () => {
    const seam = makeSeam('ok', ['10.0.0.5']);
    const strict = { allow: [], allow_private_urls: false };
    const sf = new ScopedFetchImpl(new Set(['*']), strict, seam);
    await expect(sf.fetch('http://internal.example.com/')).rejects.toThrow('HOST_NOT_ALLOWED');
    expect(seam.fetchImpl).not.toHaveBeenCalled();
  });
});
describe('ScopedFsImpl', () => {
  const makeStorage = () => ({
    read: vi.fn(),
    readBytes: vi.fn(),
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
    chmod: vi.fn(),
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
  it('mtime returns the storage value within read reach', async () => {
    const storage = makeStorage();
    storage.mtime.mockResolvedValue(1234);
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    expect(await fs.mtime('/data/file.txt')).toBe(1234);
  });
  it('mtime returns null forwarded from storage', async () => {
    const storage = makeStorage();
    storage.mtime.mockResolvedValue(null);
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    expect(await fs.mtime('/data/missing.txt')).toBeNull();
  });
  it('mtime throws PATH_NOT_REACHABLE outside read reach', async () => {
    const storage = makeStorage();
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    await expect(fs.mtime('/etc/shadow')).rejects.toThrow('PATH_NOT_REACHABLE');
  });
  it('mkdir succeeds within write reach', async () => {
    const storage = makeStorage();
    storage.mkdir.mockResolvedValue(undefined);
    const fs = new ScopedFsImpl(storage, new Set([]), new Set(['/out']));
    await fs.mkdir('/out/sub');
    expect(storage.mkdir).toHaveBeenCalledWith('/out/sub');
  });
  it('mkdir throws PATH_NOT_REACHABLE outside write reach', async () => {
    const storage = makeStorage();
    const fs = new ScopedFsImpl(storage, new Set([]), new Set(['/out']));
    await expect(fs.mkdir('/etc')).rejects.toThrow('PATH_NOT_REACHABLE');
  });
  it('listEntries succeeds within read reach', async () => {
    const storage = makeStorage();
    storage.listEntries.mockResolvedValue([{ name: 'a.txt', isDir: false }]);
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    const entries = await fs.listEntries('/data');
    expect(entries).toEqual([{ name: 'a.txt', isDir: false }]);
  });
  it('listEntries throws PATH_NOT_REACHABLE outside read reach', async () => {
    const storage = makeStorage();
    const fs = new ScopedFsImpl(storage, new Set(['/data']), new Set([]));
    await expect(fs.listEntries('/tmp')).rejects.toThrow('PATH_NOT_REACHABLE');
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
