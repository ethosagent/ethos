import type { Tool, ToolResult } from '@ethosagent/types';

export interface TtsProvider {
  synthesize(
    text: string,
    opts?: { voice?: string; speed?: number },
  ): Promise<{
    audio: Buffer;
    format: 'mp3' | 'opus' | 'wav';
  }>;
  readonly name: string;
  readonly availableVoices: string[];
}

export interface TtsToolsOptions {
  provider: TtsProvider | null;
}

export function createTtsTools(opts: TtsToolsOptions): Tool[] {
  const textToSpeechTool: Tool = {
    name: 'text_to_speech',
    description:
      'Convert text to speech audio. Returns audio data that channel adapters will deliver as a voice message. Requires a TTS provider to be configured.',
    toolset: 'voice',
    maxResultChars: 1024,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to convert to speech (max 4096 characters)',
        },
        voice: {
          type: 'string',
          description: 'Voice to use (provider-specific). Omit to use default.',
        },
        speed: {
          type: 'number',
          description: 'Speed multiplier (0.25 to 4.0, default 1.0)',
        },
      },
      required: ['text'],
    },
    isAvailable: () => opts.provider !== null,
    async execute(args): Promise<ToolResult> {
      const { text, voice, speed } = args as {
        text: string;
        voice?: string;
        speed?: number;
      };

      if (!text) return { ok: false, error: 'text is required', code: 'input_invalid' };
      if (text.length > 4096) {
        return { ok: false, error: 'Text exceeds 4096 character limit', code: 'input_invalid' };
      }

      if (!opts.provider) {
        return {
          ok: false,
          error: 'No TTS provider configured. Set auxiliary.tts in config.yaml.',
          code: 'not_available',
        };
      }

      if (speed !== undefined && (speed < 0.25 || speed > 4.0)) {
        return { ok: false, error: 'Speed must be between 0.25 and 4.0', code: 'input_invalid' };
      }

      try {
        const result = await opts.provider.synthesize(text, { voice, speed });
        const b64 = result.audio.toString('base64');
        return {
          ok: true,
          value: JSON.stringify({
            type: 'audio',
            format: result.format,
            audio_base64: b64,
            text_length: text.length,
            provider: opts.provider.name,
          }),
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };

  return [textToSpeechTool];
}
