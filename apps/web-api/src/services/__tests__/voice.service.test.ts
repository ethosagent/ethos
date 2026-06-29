import { describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../voice.service';

describe('VoiceService', () => {
  it('isConfigured returns false when no registry or provider name', () => {
    const svc = new VoiceService({});
    expect(svc.isConfigured).toBe(false);
  });

  it('isConfigured returns true when registry and provider name are set', () => {
    const registry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => ['test-stt']),
    };
    const svc = new VoiceService({
      sttRegistry: registry,
      providerName: 'test-stt',
    });
    expect(svc.isConfigured).toBe(true);
  });

  it('transcribe throws when no provider is configured', async () => {
    const svc = new VoiceService({});
    await expect(svc.transcribe('dGVzdA==', 'audio/webm')).rejects.toThrow(
      /No STT provider configured/,
    );
  });

  it('transcribe uses configGetter when initial provider is not set', async () => {
    const mockProvider = {
      name: 'test-stt',
      caps: { kind: 'stt' as const, formats: ['opus' as const], contractVersion: 1 },
      transcribe: vi.fn().mockResolvedValue('hello world'),
    };
    const registry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(() => async () => mockProvider),
      list: vi.fn(() => ['test-stt']),
    };
    const svc = new VoiceService({
      sttRegistry: registry,
      configGetter: async () => ({ voiceProvider: 'test-stt', voiceApiKey: 'key123' }),
    });

    const result = await svc.transcribe('dGVzdA==', 'audio/webm');
    expect(result).toBe('hello world');
    expect(registry.get).toHaveBeenCalledWith('test-stt');
  });

  it('transcribe filters hallucinated text', async () => {
    const mockProvider = {
      name: 'test-stt',
      caps: { kind: 'stt' as const, formats: ['opus' as const], contractVersion: 1 },
      transcribe: vi.fn().mockResolvedValue('Thanks for watching!'),
    };
    const registry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(() => async () => mockProvider),
      list: vi.fn(() => ['test-stt']),
    };
    const svc = new VoiceService({
      sttRegistry: registry,
      providerName: 'test-stt',
    });

    await expect(svc.transcribe('dGVzdA==', 'audio/webm')).rejects.toThrow(
      /Could not transcribe/,
    );
  });

  it('transcribe filters empty text', async () => {
    const mockProvider = {
      name: 'test-stt',
      caps: { kind: 'stt' as const, formats: ['opus' as const], contractVersion: 1 },
      transcribe: vi.fn().mockResolvedValue('   '),
    };
    const registry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(() => async () => mockProvider),
      list: vi.fn(() => ['test-stt']),
    };
    const svc = new VoiceService({
      sttRegistry: registry,
      providerName: 'test-stt',
    });

    await expect(svc.transcribe('dGVzdA==', 'audio/webm')).rejects.toThrow(
      /Could not transcribe/,
    );
  });
});
