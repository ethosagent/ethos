import { parseConfigYaml, resolveShareLinks } from '@ethosagent/config';

// The share-link settings as `config.yaml` says right now (plan share-links D11, D14).
// Read per call, never cached: `ethos serve` does not live-reload config.yaml, so a
// cached copy would keep serving public links after the operator turned the switch off.
// Every failure (no file, unreadable, unparseable) reads as OFF: a broken config must
// never leave publishing on. Pinned by __tests__/share-settings.test.ts.

export interface ShareSettings {
  enabled: boolean;
  excludePersonalities: readonly string[];
  /** Top-level `webBaseUrl`, the advertised base for share URLs (D4). */
  webBaseUrl?: string;
}

export type ShareSettingsReader = () => Promise<ShareSettings>;

const OFF: ShareSettings = { enabled: false, excludePersonalities: [] };

export function createShareSettings(source: {
  readSource(): Promise<string | null>;
}): ShareSettingsReader {
  return async () => {
    try {
      const src = await source.readSource();
      if (src === null) return OFF;
      const config = parseConfigYaml(src);
      const { enabled, excludePersonalities } = resolveShareLinks(config);
      return {
        enabled,
        excludePersonalities,
        ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
      };
    } catch {
      return OFF;
    }
  };
}
