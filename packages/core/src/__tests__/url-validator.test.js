import { describe, expect, it } from 'vitest';
import { SsrfError, validateUrl } from '../url-validator';

describe('validateUrl', () => {
  it('allows normal HTTPS URLs', () => {
    expect(() => validateUrl('https://api.example.com/v1')).not.toThrow();
  });
  it('allows normal HTTP URLs', () => {
    expect(() => validateUrl('http://api.example.com/v1')).not.toThrow();
  });
  it('returns the parsed URL object', () => {
    const url = validateUrl('https://api.openai.com/v1/chat');
    expect(url.hostname).toBe('api.openai.com');
    expect(url.pathname).toBe('/v1/chat');
  });
  it('rejects non-http schemes', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(SsrfError);
    expect(() => validateUrl('ftp://internal.host/data')).toThrow(SsrfError);
    expect(() => validateUrl('gopher://evil.com/')).toThrow(SsrfError);
    expect(() => validateUrl('javascript:alert(1)')).toThrow(SsrfError);
    expect(() => validateUrl('data:text/html,<h1>hi</h1>')).toThrow(SsrfError);
  });
  it('rejects malformed URLs', () => {
    expect(() => validateUrl('not a url')).toThrow(SsrfError);
    expect(() => validateUrl('')).toThrow(SsrfError);
  });
  it('rejects URLs with embedded credentials', () => {
    expect(() => validateUrl('http://user:pass@example.com/')).toThrow(SsrfError);
    expect(() => validateUrl('http://admin@example.com/')).toThrow(SsrfError);
  });
  it('rejects private IPv4 ranges', () => {
    expect(() => validateUrl('http://127.0.0.1/')).toThrow(SsrfError);
    expect(() => validateUrl('http://10.0.0.1/')).toThrow(SsrfError);
    expect(() => validateUrl('http://192.168.1.1/')).toThrow(SsrfError);
    expect(() => validateUrl('http://169.254.169.254/')).toThrow(SsrfError);
    expect(() => validateUrl('http://172.16.0.1/')).toThrow(SsrfError);
    expect(() => validateUrl('http://172.31.255.255/')).toThrow(SsrfError);
  });
  it('rejects link-local / AWS metadata IP', () => {
    expect(() => validateUrl('http://169.254.169.254/latest/meta-data/')).toThrow(SsrfError);
  });
  it('rejects localhost hostname', () => {
    expect(() => validateUrl('http://localhost:8080/')).toThrow(SsrfError);
    expect(() => validateUrl('http://myhost.local/')).toThrow(SsrfError);
  });
  it('allows localhost when opted in', () => {
    expect(() => validateUrl('http://localhost:8080/', { allowLocalhost: true })).not.toThrow();
    expect(() => validateUrl('http://127.0.0.1:11434/', { allowLocalhost: true })).not.toThrow();
    expect(() => validateUrl('http://[::1]:11434/', { allowLocalhost: true })).not.toThrow();
  });
  it('still blocks non-loopback private IPs even with allowLocalhost', () => {
    expect(() => validateUrl('http://192.168.1.1:8080/', { allowLocalhost: true })).toThrow(
      SsrfError,
    );
    expect(() => validateUrl('http://10.0.0.1/', { allowLocalhost: true })).toThrow(SsrfError);
    expect(() => validateUrl('http://172.16.0.1/', { allowLocalhost: true })).toThrow(SsrfError);
  });
  it('still blocks cloud metadata even with allowLocalhost', () => {
    expect(() => validateUrl('http://169.254.169.254/', { allowLocalhost: true })).toThrow(
      SsrfError,
    );
    expect(() => validateUrl('http://metadata.google.internal/', { allowLocalhost: true })).toThrow(
      SsrfError,
    );
  });
  it('allows trusted hosts even if they look private', () => {
    expect(() => validateUrl('http://10.0.0.1/', { trustedHosts: ['10.0.0.1'] })).not.toThrow();
  });
  it('rejects .internal hostnames', () => {
    expect(() => validateUrl('http://metadata.google.internal/')).toThrow(SsrfError);
    expect(() => validateUrl('http://something.internal/')).toThrow(SsrfError);
  });
  it('rejects cloud metadata hosts by name', () => {
    expect(() => validateUrl('http://metadata.azure.com/')).toThrow(SsrfError);
    expect(() => validateUrl('http://metadata.aws.amazon.com/')).toThrow(SsrfError);
  });
  it('rejects IPv6 loopback', () => {
    expect(() => validateUrl('http://[::1]/')).toThrow(SsrfError);
  });
  it('rejects IPv6 link-local', () => {
    expect(() => validateUrl('http://[fe80::1]/')).toThrow(SsrfError);
  });
  it('rejects IPv6 unique-local', () => {
    expect(() => validateUrl('http://[fd00::1]/')).toThrow(SsrfError);
  });
  it('allows public IPs', () => {
    expect(() => validateUrl('http://8.8.8.8/')).not.toThrow();
    expect(() => validateUrl('https://1.1.1.1/')).not.toThrow();
    expect(() => validateUrl('http://93.184.216.34/')).not.toThrow();
  });
});
