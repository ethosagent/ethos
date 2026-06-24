import { describe, expect, it } from 'vitest';
import { activate } from '../index';

describe('gemini-native plugin activate', () => {
  it('registers the bare provider name "gemini-native"', () => {
    const registered: string[] = [];
    const api = {
      registerLLMProvider(name: string) {
        registered.push(name);
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock api for activate test
    } as any;
    activate(api);
    expect(registered).toEqual(['gemini-native']);
  });
});
