// openclaw-advisory-fixes L-d: the CSRF middleware accepts a localhost Origin
// only when it equals the request `Host` (`isSameOriginLocalhost` in
// ../middleware/csrf.ts). The Vite dev server satisfies that only because
// every API-bound proxy entry sets `changeOrigin: false`, so the API sees
// `Host: localhost:5173`. A plain-string entry is `changeOrigin: true` in Vite
// (it rewrites Host to the target), which would refuse every dev-mode write.
// This pins the config at the source so such an entry fails CI, not dev.
//
// Reads the file rather than importing it: importing would pull Vite and the
// React plugin into the web-api test graph.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_TAKEOVER_SOCKET_PATH, VOICE_SOCKET_PATH } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';

const CONFIG = join(import.meta.dirname, '..', '..', '..', 'web', 'vite.config.ts');

/** The top-level entries of `server.proxy`, each with its raw value text. */
function proxyEntries(src: string): Array<{ path: string; value: string }> {
  const start = src.indexOf('proxy: {');
  if (start < 0) throw new Error('no `proxy: {` block in vite.config.ts');
  let i = start + 'proxy: {'.length;
  let depth = 1;
  const body: string[] = [];
  for (; i < src.length && depth > 0; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth > 0) body.push(ch ?? '');
  }
  const text = body
    .join('')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const entries: Array<{ path: string; value: string }> = [];
  const keyRe = /'(\/[^']*)':\s*/g;
  let m: RegExpExecArray | null = keyRe.exec(text);
  while (m !== null) {
    const path = m[1] ?? '';
    let j = keyRe.lastIndex;
    let value = '';
    if (text[j] === '{') {
      let d = 0;
      for (; j < text.length; j++) {
        const ch = text[j];
        value += ch;
        if (ch === '{') d++;
        if (ch === '}' && --d === 0) break;
      }
      keyRe.lastIndex = j;
    } else {
      value = text.slice(j, text.indexOf(',', j));
    }
    entries.push({ path, value });
    m = keyRe.exec(text);
  }
  return entries;
}

describe('apps/web/vite.config.ts proxy — same-origin Host for CSRF', () => {
  const entries = proxyEntries(readFileSync(CONFIG, 'utf8'));

  it('finds the API-bound proxy entries', () => {
    expect(entries.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        '/rpc',
        '/sse',
        '/auth',
        '/oauth',
        '/documents',
        '/api',
        '/setup/whatsapp/',
      ]),
    );
  });

  it('every entry is an object with changeOrigin: false', () => {
    for (const entry of entries) {
      expect(entry.value, `${entry.path} must be an object`).toMatch(/^\{/);
      expect(entry.value, `${entry.path} must set changeOrigin: false`).toMatch(
        /changeOrigin:\s*false/,
      );
    }
  });

  // `/setup/whatsapp/:botId` is also a page route, so the entry must hand
  // everything but the event stream back to the SPA. `changeOrigin: false` is
  // covered by the loop above; this pins the split.
  it('proxies only the WhatsApp setup event stream', () => {
    const entry = entries.find((e) => e.path === '/setup/whatsapp/');
    expect(entry?.value, '/setup/whatsapp/ must set a bypass').toMatch(/bypass:/);
    expect(entry?.value, 'bypass must key on the event-stream Accept header').toMatch(
      /text\/event-stream/,
    );
  });

  // The SPA opens these at `${location.host}<path>`, so on :5173 they reach the
  // API only through the proxy. The upgrade Origin check (`originAllowed` in
  // ../voice/voice-socket.ts) needs `Host` to stay `localhost:5173`, the same
  // reason as the HTTP entries.
  it('proxies the SPA WebSocket paths with ws: true and changeOrigin: false', () => {
    for (const path of [VOICE_SOCKET_PATH, BROWSER_TAKEOVER_SOCKET_PATH]) {
      const entry = entries.find((e) => e.path === path);
      expect(entry, `${path} must have a proxy entry`).toBeDefined();
      expect(entry?.value, `${path} must set ws: true`).toMatch(/ws:\s*true/);
      expect(entry?.value, `${path} must set changeOrigin: false`).toMatch(/changeOrigin:\s*false/);
    }
  });
});
