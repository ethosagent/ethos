import { describe, expect, it } from 'vitest';
import { CommandSttProvider } from '../command-stt';
import { CommandTtsProvider } from '../command-tts';

describe('CommandSttProvider', () => {
  it('has correct caps', () => {
    const provider = new CommandSttProvider({
      name: 'test-stt',
      command: 'echo "hello" > {output_path}',
    });
    expect(provider.name).toBe('test-stt');
    expect(provider.caps.kind).toBe('stt');
    expect(provider.caps.local).toBe(true);
    expect(provider.caps.formats).toContain('opus');
  });
});

describe('CommandTtsProvider', () => {
  it('has correct caps', () => {
    const provider = new CommandTtsProvider({
      name: 'test-tts',
      command: 'echo "audio" > {output_path}',
      outputFormat: 'mp3',
    });
    expect(provider.name).toBe('test-tts');
    expect(provider.caps.kind).toBe('tts');
    expect(provider.caps.local).toBe(true);
    expect(provider.caps.formats).toEqual(['mp3']);
  });
});
