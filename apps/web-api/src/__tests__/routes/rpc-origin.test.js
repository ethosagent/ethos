import { describe, expect, it } from 'vitest';
import { deriveMcpRequestOrigin } from '../../routes/rpc-origin';

// Trust-policy unit tests for the per-request OAuth callback origin
// derivation. Verified independently from the Hono layer so the rules
// (loopback / RFC 1918 / webBaseUrl allowlist) stay legible.
function makeReq(opts) {
  const headers = new Headers();
  if (opts.origin !== undefined) headers.set('origin', opts.origin);
  if (opts.host !== undefined) headers.set('host', opts.host);
  return new Request(opts.url ?? 'http://localhost/rpc/mcp.start', {
    method: 'POST',
    headers,
  });
}
describe('deriveMcpRequestOrigin — Origin header', () => {
  it('accepts localhost on any port', () => {
    const req = makeReq({ origin: 'http://localhost:3000' });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('http://localhost:3000');
  });
  it('accepts a different localhost port (vite default 5173)', () => {
    const req = makeReq({ origin: 'http://localhost:5173' });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('http://localhost:5173');
  });
  it('accepts 127.0.0.1', () => {
    const req = makeReq({ origin: 'http://127.0.0.1:8080' });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('http://127.0.0.1:8080');
  });
  it('accepts ::1 (IPv6 loopback)', () => {
    const req = makeReq({ origin: 'http://[::1]:3000' });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('http://[::1]:3000');
  });
  it('accepts RFC 1918 192.168.x.x', () => {
    const req = makeReq({ origin: 'http://192.168.1.42:5173' });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('http://192.168.1.42:5173');
  });
  it('accepts RFC 1918 10.x.x.x', () => {
    const req = makeReq({ origin: 'http://10.0.0.5:8080' });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('http://10.0.0.5:8080');
  });
  it('accepts RFC 1918 172.16-31.x.x', () => {
    expect(deriveMcpRequestOrigin(makeReq({ origin: 'http://172.16.0.1' }), undefined)).toBe(
      'http://172.16.0.1',
    );
    expect(deriveMcpRequestOrigin(makeReq({ origin: 'http://172.31.255.255' }), undefined)).toBe(
      'http://172.31.255.255',
    );
  });
  it('rejects 172.15.x (outside RFC 1918)', () => {
    expect(
      deriveMcpRequestOrigin(makeReq({ origin: 'http://172.15.0.1' }), undefined),
    ).toBeUndefined();
  });
  it('rejects 172.32.x (outside RFC 1918)', () => {
    expect(
      deriveMcpRequestOrigin(makeReq({ origin: 'http://172.32.0.1' }), undefined),
    ).toBeUndefined();
  });
  it('rejects a public origin when no webBaseUrl is configured', () => {
    const req = makeReq({ origin: 'https://evil.example.com' });
    expect(deriveMcpRequestOrigin(req, undefined)).toBeUndefined();
  });
  it('accepts a public origin only when it matches webBaseUrl', () => {
    const req = makeReq({ origin: 'https://ethos.example.com' });
    expect(deriveMcpRequestOrigin(req, 'https://ethos.example.com')).toBe(
      'https://ethos.example.com',
    );
  });
  it('rejects a public origin that does NOT match webBaseUrl', () => {
    const req = makeReq({ origin: 'https://evil.example.com' });
    expect(deriveMcpRequestOrigin(req, 'https://ethos.example.com')).toBeUndefined();
  });
  it('webBaseUrl with a path component still matches on origin only', () => {
    const req = makeReq({ origin: 'https://ethos.example.com' });
    expect(deriveMcpRequestOrigin(req, 'https://ethos.example.com/admin/')).toBe(
      'https://ethos.example.com',
    );
  });
});
describe('deriveMcpRequestOrigin — Host fallback', () => {
  it('falls back to <scheme>://<host> when Origin is missing', () => {
    const req = makeReq({
      url: 'http://localhost:3000/rpc/mcp.start',
      host: 'localhost:3000',
    });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('http://localhost:3000');
  });
  it('uses https when the request URL is https', () => {
    const req = makeReq({
      url: 'https://localhost/rpc/mcp.start',
      host: 'localhost',
    });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('https://localhost');
  });
  it('returns undefined when both Origin and Host are missing', () => {
    // The Fetch Request constructor populates Host implicitly from the URL,
    // so manually clear via a stub-shaped object.
    const stub = {
      url: 'http://localhost/rpc/mcp.start',
      headers: new Headers(),
    };
    expect(deriveMcpRequestOrigin(stub, undefined)).toBeUndefined();
  });
  it('Host fallback still subject to trust policy — rejects a public host', () => {
    const req = makeReq({
      url: 'https://evil.example.com/rpc/mcp.start',
      host: 'evil.example.com',
    });
    expect(deriveMcpRequestOrigin(req, undefined)).toBeUndefined();
  });
  it('Origin takes precedence over Host when both are present', () => {
    // Origin: localhost (trusted) — Host: evil.example (would be rejected).
    // The function should pick Origin and return success.
    const req = makeReq({
      url: 'http://evil.example.com/rpc/mcp.start',
      origin: 'http://localhost:3000',
      host: 'evil.example.com',
    });
    expect(deriveMcpRequestOrigin(req, undefined)).toBe('http://localhost:3000');
  });
});
