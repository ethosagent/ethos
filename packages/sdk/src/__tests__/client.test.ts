import { describe, expect, it } from 'vitest';
import { EthosClient } from '../client';

describe('EthosClient', () => {
  it('constructs with base URL and API key', () => {
    const client = new EthosClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test123',
    });

    expect(client.baseUrl).toBe('http://localhost:3000');
    expect(client.rpc).toBeDefined();
  });

  it('strips trailing slashes from base URL', () => {
    const client = new EthosClient({
      baseUrl: 'http://localhost:3000///',
      apiKey: 'sk-ethos-test123',
    });

    expect(client.baseUrl).toBe('http://localhost:3000');
  });

  it('exposes typed contract namespaces', () => {
    const client = new EthosClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test123',
    });

    expect(client.rpc.sessions).toBeDefined();
    expect(client.rpc.chat).toBeDefined();
    expect(client.rpc.personalities).toBeDefined();
    expect(client.rpc.memory).toBeDefined();
    expect(client.rpc.meta).toBeDefined();
    expect(client.rpc.apiKeys).toBeDefined();
  });

  it('constructs without apiKey for cookie-auth mode', () => {
    const client = new EthosClient({
      baseUrl: 'http://localhost:3000',
    });

    expect(client.baseUrl).toBe('http://localhost:3000');
    expect(client.rpc).toBeDefined();
  });
});
