// Shared OpenAI-compatible voice transport.
//
// Both the cloud `openai-*` providers and the self-hosted `local-*` providers
// speak the same HTTP protocol: STT via `POST {baseUrl}/audio/transcriptions`
// (multipart file + model) and TTS via `POST {baseUrl}/audio/speech` (json).
// The only axis that differs is authentication: cloud endpoints require an API
// key; local servers (Kokoro, faster-whisper) usually need none. The API key is
// therefore OPTIONAL here — the `Authorization` header is sent only when a key
// is present and omitted entirely when absent.

import { basename, extname } from 'node:path';

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Extension → audio MIME. Covers the formats the browser records and OpenAI-compatible servers accept. */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
};

/**
 * Derive the multipart `file` part (filename + content-type) from the audio path.
 * The upstream service writes the temp file with the correct extension for the recorded
 * format, so honouring it here keeps strict servers (Speaches / faster-whisper) from
 * rejecting the upload with 415. Unknown/missing extension → best-effort octet-stream.
 */
function audioFilePart(audioPath: string): { filename: string; contentType: string } {
  const ext = extname(audioPath).toLowerCase();
  const contentType = AUDIO_MIME_BY_EXT[ext];
  if (!contentType) return { filename: 'audio', contentType: 'application/octet-stream' };
  return { filename: basename(audioPath), contentType };
}

/** STT — POST {baseUrl}/audio/transcriptions, multipart `file` + `model`, returns `{ text }`. */
export async function transcribeOpenAiCompat(opts: {
  baseUrl: string;
  model: string;
  audioPath: string;
  /** Optional bearer key. When absent, no `Authorization` header is sent. */
  apiKey?: string;
  /** Prefix for the thrown error message, e.g. `'OpenAI STT'` / `'Local STT'`. */
  label: string;
  /** Aborts the upload when the caller/UI times out. Absent → no timeout here. */
  signal?: AbortSignal;
}): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const data = await readFile(opts.audioPath);
  const { filename, contentType } = audioFilePart(opts.audioPath);
  const blob = new Blob([data], { type: contentType });
  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('model', opts.model);

  const res = await fetch(`${opts.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: authHeaders(opts.apiKey),
    body: formData,
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${opts.label} failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { text: string };
  return json.text;
}

/** TTS — POST {baseUrl}/audio/speech, json body, returns opus audio bytes. */
export async function synthesizeOpenAiCompat(opts: {
  baseUrl: string;
  model: string;
  voice: string;
  input: string;
  /** Optional bearer key. When absent, no `Authorization` header is sent. */
  apiKey?: string;
  speed?: number;
  /** Prefix for the thrown error message, e.g. `'OpenAI TTS'` / `'Local TTS'`. */
  label: string;
  /** Aborts the request when the caller/UI times out. Absent → no timeout here. */
  signal?: AbortSignal;
}): Promise<{ audio: Uint8Array; format: 'opus' }> {
  const res = await fetch(`${opts.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      ...authHeaders(opts.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      input: opts.input,
      voice: opts.voice,
      speed: opts.speed ?? 1.0,
      response_format: 'opus',
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${opts.label} failed (${res.status}): ${body}`);
  }

  const buffer = await res.arrayBuffer();
  return { audio: new Uint8Array(buffer), format: 'opus' };
}
