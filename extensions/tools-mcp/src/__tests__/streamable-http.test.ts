import type { Logger } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { McpClient } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Subclass that exposes _createTransport for direct testing without
 * actually connecting to a real server.
 */
class ExposedMcpClient extends McpClient {
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  async createTransportPublic(): Promise<any> {
    return this._createTransport();
  }
}

// ---------------------------------------------------------------------------
// streamable-http transport
// ---------------------------------------------------------------------------

describe('streamable-http transport', () => {
  it('creates StreamableHTTPClientTransport for streamable-http config', async () => {
    const client = new ExposedMcpClient(
      { name: 'test-sh', transport: 'streamable-http', url: 'http://localhost:3300/mcp', keepaliveSeconds: 0 },
    );

    const transport = await client.createTransportPublic();
    // The transport should be an instance of StreamableHTTPClientTransport
    expect(transport).toBeDefined();
    expect(transport.constructor.name).toBe('StreamableHTTPClientTransport');
  });

  it('throws when streamable-http config lacks url', async () => {
    const client = new ExposedMcpClient(
      { name: 'no-url', transport: 'streamable-http', keepaliveSeconds: 0 },
    );

    await expect(client.createTransportPublic()).rejects.toThrow(
      "streamable-http transport requires 'url'",
    );
  });
});

// ---------------------------------------------------------------------------
// SSE deprecation warning
// ---------------------------------------------------------------------------

describe('SSE deprecation warning', () => {
  it('emits deprecation warning when SSE transport is used', async () => {
    const warnFn = vi.fn();
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnFn,
      error: vi.fn(),
      child: () => logger,
    };

    const client = new ExposedMcpClient(
      { name: 'legacy-sse', transport: 'sse', url: 'http://localhost:9999/sse', keepaliveSeconds: 0 },
      { logger },
    );

    const transport = await client.createTransportPublic();
    expect(transport).toBeDefined();
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining('SSE transport is deprecated'),
      expect.objectContaining({ component: 'tools-mcp', server: 'legacy-sse' }),
    );
  });

  it('does not emit deprecation warning for streamable-http', async () => {
    const warnFn = vi.fn();
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnFn,
      error: vi.fn(),
      child: () => logger,
    };

    const client = new ExposedMcpClient(
      { name: 'modern', transport: 'streamable-http', url: 'http://localhost:9999/mcp', keepaliveSeconds: 0 },
      { logger },
    );

    await client.createTransportPublic();
    expect(warnFn).not.toHaveBeenCalled();
  });
});
