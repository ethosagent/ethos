import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretsResolver, SttProvider, SttProviderRegistry } from '@ethosagent/types';

const HALLUCINATION_PATTERNS = [
  /^thanks?\s*(you\s*)?(for\s+)?(watching|listening|viewing)/i,
  /^please\s+(like\s+and\s+)?subscribe/i,
  /^(sub(scribe)?|like)\s+(to\s+)?(the\s+)?channel/i,
  /^\s*$/,
  /^\.+$/,
  /^you$/i,
  /^(music|applause|laughter)\s*$/i,
  /^\[.*\]\s*$/,
];

function isHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return HALLUCINATION_PATTERNS.some((p) => p.test(trimmed));
}

export class VoiceService {
  private readonly sttRegistry: SttProviderRegistry | undefined;
  private readonly initialProviderName: string | undefined;
  private readonly initialProviderConfig: Record<string, unknown>;
  private readonly secrets: SecretsResolver | undefined;
  private readonly configGetter?: () => Promise<{ voiceProvider?: string | null; voiceApiKey?: string | null } | null>;
  private provider: SttProvider | null = null;
  private resolvedName: string | undefined;

  get isConfigured(): boolean {
    return Boolean(this.sttRegistry && this.initialProviderName);
  }

  constructor(opts: {
    sttRegistry?: SttProviderRegistry;
    providerName?: string;
    providerConfig?: Record<string, unknown>;
    secrets?: SecretsResolver;
    configGetter?: () => Promise<{ voiceProvider?: string | null; voiceApiKey?: string | null } | null>;
  }) {
    this.sttRegistry = opts.sttRegistry;
    this.initialProviderName = opts.providerName;
    this.initialProviderConfig = opts.providerConfig ?? {};
    this.secrets = opts.secrets;
    this.configGetter = opts.configGetter;
  }

  private async resolve(): Promise<SttProvider | null> {
    let name = this.initialProviderName;
    let config: Record<string, unknown> = this.initialProviderConfig;

    if (!name && this.configGetter) {
      const live = await this.configGetter().catch(() => null);
      if (live?.voiceProvider) {
        name = live.voiceProvider;
        config = { apiKey: live.voiceApiKey ?? undefined };
      }
    }

    if (this.resolvedName === name && this.provider) return this.provider;
    if (!this.sttRegistry || !name) return null;

    const factory = this.sttRegistry.get(name);
    if (!factory) return null;
    try {
      const noopSecrets: SecretsResolver = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      };
      this.provider = await factory({
        config,
        secrets: this.secrets ?? noopSecrets,
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
          child() {
            return this;
          },
        },
      });
      this.resolvedName = name;
    } catch {
      this.provider = null;
    }
    return this.provider;
  }

  async transcribe(audioBase64: string, mimeType: string): Promise<string> {
    const provider = await this.resolve();
    if (!provider) {
      throw new Error('No STT provider configured — set auxiliary.asr in config');
    }

    const buf = Buffer.from(audioBase64, 'base64');
    const ext = mimeType.includes('webm') ? '.webm' : mimeType.includes('ogg') ? '.ogg' : '.wav';
    const tempPath = join(tmpdir(), `ethos-web-stt-${randomBytes(8).toString('hex')}${ext}`);

    try {
      await writeFile(tempPath, buf);
      const raw = await provider.transcribe(tempPath);
      if (isHallucination(raw)) {
        throw new Error('Could not transcribe audio — try again');
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        throw new Error('Could not transcribe audio — try again');
      }
      return trimmed;
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }
}
