import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TtsProvider, VoiceCapabilities } from '@ethosagent/types';

export interface CommandTtsConfig {
  name: string;
  command: string;
  outputFormat?: 'opus' | 'mp3' | 'wav' | 'pcm';
  timeout?: number;
  maxTextLength?: number;
  voices?: string[];
}

export class CommandTtsProvider implements TtsProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  private readonly command: string;
  private readonly timeout: number;
  private readonly outputFormat: 'opus' | 'mp3' | 'wav' | 'pcm';

  constructor(config: CommandTtsConfig) {
    this.name = config.name;
    this.command = config.command;
    this.timeout = (config.timeout ?? 120) * 1000;
    this.outputFormat = config.outputFormat ?? 'mp3';
    this.caps = {
      kind: 'tts',
      formats: [this.outputFormat],
      local: true,
      voices: config.voices,
      maxInputChars: config.maxTextLength,
      contractVersion: 1,
    };
  }

  async synthesize(
    text: string,
    opts?: { voice?: string; speed?: number },
  ): Promise<{ audio: Uint8Array; format: 'opus' | 'mp3' | 'wav' | 'pcm' }> {
    const inputPath = join(tmpdir(), `ethos-tts-in-${randomBytes(8).toString('hex')}.txt`);
    const outputPath = join(
      tmpdir(),
      `ethos-tts-out-${randomBytes(8).toString('hex')}.${this.outputFormat}`,
    );

    await writeFile(inputPath, text, 'utf-8');

    const cmd = this.command
      .replace(/\{input_path\}/g, inputPath)
      .replace(/\{output_path\}/g, outputPath)
      .replace(/\{format\}/g, this.outputFormat)
      .replace(/\{voice\}/g, opts?.voice ?? '')
      .replace(/\{speed\}/g, String(opts?.speed ?? 1.0));

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('sh', ['-c', cmd], { timeout: this.timeout }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const data = await readFile(outputPath);
      return { audio: new Uint8Array(data), format: this.outputFormat };
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }
}
