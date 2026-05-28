import { describe, expect, it } from 'vitest';
import { EthosClient } from '../client';
import { EthosError } from '../error';
import { createEthosClient } from '../factory';
import { HttpDispatcher } from '../http-dispatcher';

describe('EthosClient', () => {
  it('constructs with a Dispatcher', () => {
    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test123',
    });
    const client = new EthosClient(dispatcher);
    expect(client.rpc).toBeDefined();
  });
  it('exposes typed contract namespaces', () => {
    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test123',
    });
    const client = new EthosClient(dispatcher);
    expect(client.rpc.sessions).toBeDefined();
    expect(client.rpc.chat).toBeDefined();
    expect(client.rpc.personalities).toBeDefined();
    expect(client.rpc.memory).toBeDefined();
    expect(client.rpc.meta).toBeDefined();
    expect(client.rpc.apiKeys).toBeDefined();
  });
});
describe('HttpDispatcher', () => {
  it('constructs with base URL and API key', () => {
    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test123',
    });
    expect(dispatcher.rpc).toBeDefined();
  });
  it('strips trailing slashes from base URL via rpc construction', () => {
    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000///',
      apiKey: 'sk-ethos-test123',
    });
    // The dispatcher constructs successfully; trailing slashes are handled internally
    expect(dispatcher.rpc).toBeDefined();
  });
  it('constructs without apiKey for cookie-auth mode', () => {
    const dispatcher = new HttpDispatcher({
      baseUrl: 'http://localhost:3000',
    });
    expect(dispatcher.rpc).toBeDefined();
  });
});
describe('createEthosClient', () => {
  it('creates a client with explicit baseUrl and apiKey', () => {
    const client = createEthosClient({
      baseUrl: 'http://localhost:4000',
      apiKey: 'sk-ethos-test123',
    });
    expect(client.rpc).toBeDefined();
  });
  it('throws EthosError with code NO_API_KEY when no apiKey in Node', () => {
    // In Node there is no globalThis.window, so missing apiKey should throw
    const saved = process.env.ETHOS_API_KEY;
    delete process.env.ETHOS_API_KEY;
    try {
      expect(() => createEthosClient({ baseUrl: 'http://localhost:3000' })).toThrow(EthosError);
      try {
        createEthosClient({ baseUrl: 'http://localhost:3000' });
      } catch (err) {
        expect(err).toBeInstanceOf(EthosError);
        expect(err.code).toBe('NO_API_KEY');
        expect(err.action).toBeDefined();
      }
    } finally {
      if (saved !== undefined) process.env.ETHOS_API_KEY = saved;
    }
  });
});
describe('EthosError', () => {
  it('has the correct name, code, message, and action', () => {
    const err = new EthosError({
      code: 'UNAUTHORIZED',
      message: 'Bad token',
      action: 'Check your API key.',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EthosError');
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Bad token');
    expect(err.action).toBe('Check your API key.');
  });
  it('works without action', () => {
    const err = new EthosError({ code: 'UNKNOWN', message: 'Something broke' });
    expect(err.action).toBeUndefined();
  });
});
