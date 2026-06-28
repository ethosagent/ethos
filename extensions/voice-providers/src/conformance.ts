import type { VoiceCapabilities } from '@ethosagent/types';

export function validateVoiceCaps(caps: VoiceCapabilities): string[] {
  const errors: string[] = [];
  if (!['stt', 'tts'].includes(caps.kind)) {
    errors.push(`Invalid kind: ${caps.kind}`);
  }
  if (!Array.isArray(caps.formats) || caps.formats.length === 0) {
    errors.push('formats must be a non-empty array');
  }
  const validFormats = new Set(['opus', 'mp3', 'wav', 'pcm']);
  for (const f of caps.formats) {
    if (!validFormats.has(f)) {
      errors.push(`Invalid format: ${f}`);
    }
  }
  if (caps.contractVersion < 1) {
    errors.push('contractVersion must be >= 1');
  }
  if (caps.maxInputChars !== undefined && caps.maxInputChars <= 0) {
    errors.push('maxInputChars must be positive');
  }
  return errors;
}
