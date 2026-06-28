import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SttProvider, VoiceCapabilities } from '@ethosagent/types';

export interface CommandSttConfig {
  name: string;
  command: string;
  outputFormat?: string;
  timeout?: number;
  languages?: string[];
}

export class CommandSttProvider implements SttProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  private readonly command: string;
  private readonly timeout: number;

  constructor(config: CommandSttConfig) {
    this.name = config.name;
    this.command = config.command;
    this.timeout = (config.timeout ?? 120) * 1000;
    this.caps = {
      kind: 'stt',
      formats: ['opus', 'mp3', 'wav'],
      local: true,
      languages: config.languages,
      contractVersion: 1,
    };
  }

  async transcribe(audioPath: string, opts?: { language?: string }): Promise<string> {
    const outputPath = join(tmpdir(), `ethos-stt-${randomBytes(8).toString('hex')}.txt`);
    const cmd = this.command
      .replace(/\{input_path\}/g, audioPath)
      .replace(/\{output_path\}/g, outputPath)
      .replace(/\{language\}/g, opts?.language ?? 'auto');

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('sh', ['-c', cmd], { timeout: this.timeout }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const result = await readFile(outputPath, 'utf-8');
      return result.trim();
    } finally {
      await unlink(outputPath).catch(() => {});
    }
  }
}
