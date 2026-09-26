import { describe, expect, it } from 'vitest';
import { credentialToFocus, parsePluginCredentialDeepLink } from '../pluginCredentialDeepLink';

const q = (s: string) => new URLSearchParams(s);

describe('parsePluginCredentialDeepLink', () => {
  it('returns the plugin and key for a listed plugin', () => {
    expect(parsePluginCredentialDeepLink(q('pluginId=weather&key=API_KEY'), ['weather'])).toEqual({
      pluginId: 'weather',
      key: 'API_KEY',
    });
  });

  it('accepts a link with no key', () => {
    expect(parsePluginCredentialDeepLink(q('pluginId=weather'), ['weather'])).toEqual({
      pluginId: 'weather',
    });
  });

  it('ignores a plugin id the list does not contain', () => {
    expect(parsePluginCredentialDeepLink(q('pluginId=..%2F..%2Fetc&key=x'), ['weather'])).toBe(
      null,
    );
  });

  it('falls back to null when the query is missing or empty', () => {
    expect(parsePluginCredentialDeepLink(q(''), ['weather'])).toBeNull();
    expect(parsePluginCredentialDeepLink(q('pluginId='), ['weather'])).toBeNull();
  });
});

describe('credentialToFocus', () => {
  it('focuses a key the plugin lists', () => {
    expect(credentialToFocus('API_KEY', ['API_KEY', 'REGION'])).toBe('API_KEY');
  });

  it('focuses nothing for a key the plugin does not list', () => {
    expect(credentialToFocus('../../secrets/keys.json', ['API_KEY'])).toBeUndefined();
    expect(credentialToFocus(undefined, ['API_KEY'])).toBeUndefined();
  });
});
