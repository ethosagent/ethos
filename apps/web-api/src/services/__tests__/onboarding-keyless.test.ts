import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { OnboardingProbeOutputSchema } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  FAKE_ACCESS,
  FAKE_ID,
  FAKE_REFRESH,
  json,
  makeFetch,
  ollamaUp,
  useKeylessHarness,
} from './onboarding-keyless-harness';

describe('onboarding keyless RPCs', () => {
  const { host, make, done, expectOrpc, home } = useKeylessHarness();

  describe('already configured', () => {
    it('every new mutation is refused with 409 ALREADY_CONFIGURED once step is done', async () => {
      const { service } = make({ config: done });
      await expectOrpc(service.probe(), 'ALREADY_CONFIGURED', 409);
      await expectOrpc(
        service.importCodexLogin({ source: 'codex-cli' }),
        'ALREADY_CONFIGURED',
        409,
      );
      await expectOrpc(service.pullModel({ model: 'qwen3' }), 'ALREADY_CONFIGURED', 409);
      await expectOrpc(
        service.namePersonality({ sourceId: 'researcher', name: 'Sage' }),
        'ALREADY_CONFIGURED',
        409,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('probe', () => {
    it('recommends a running Ollama and matches the wire schema', async () => {
      const { impl } = makeFetch({ '127.0.0.1:11434': ollamaUp(['llama3.2:latest']) });
      const { service } = make({ fetchFn: impl });

      const out = await service.probe();

      expect(OnboardingProbeOutputSchema.safeParse(out).success).toBe(true);
      expect(out.candidates[out.recommended]).toMatchObject({
        kind: 'local',
        runtime: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: ['llama3.2:latest'],
      });
      expect(out.machine).toEqual({
        totalMemGiB: 16,
        pick: { modelId: 'qwen3', approxDownloadGb: 5.2 },
      });
      expect(out.candidates.at(-1)).toEqual({ kind: 'paste-key' });
    });

    it('passes belowContextFloor through on a below-floor local candidate', async () => {
      const { impl } = makeFetch({
        '127.0.0.1:11434': (u) =>
          u.pathname.endsWith('/api/ps')
            ? json({ models: [{ name: 'llama3.2:latest', context_length: 8192 }] })
            : ollamaUp(['llama3.2:latest'])(u),
      });
      const { service } = make({ fetchFn: impl });

      const out = await service.probe();

      expect(OnboardingProbeOutputSchema.safeParse(out).success).toBe(true);
      expect(out.candidates[0]).toMatchObject({
        kind: 'local',
        contextWindow: 8192,
        belowContextFloor: { servedTokens: 8192, floorTokens: 16000 },
      });
    });

    it('with nothing local: install-offer, paste-key, and install is command TEXT only', async () => {
      const { impl } = makeFetch({});
      const { service } = make({ fetchFn: impl });

      const out = await service.probe();

      expect(out.candidates.map((c) => c.kind)).toEqual(['install-offer', 'paste-key']);
      expect(out.install).toEqual({
        os: 'linux',
        command: 'curl -fsSL https://ollama.com/install.sh | sh',
        notes: expect.stringContaining('sudo'),
        downloadUrl: null,
      });
    });

    it('as root the offered command is still text; nothing about it is runnable on the wire', async () => {
      const { impl } = makeFetch({});
      const { service } = make({ fetchFn: impl, probeHost: host({ isRoot: true }) });
      const out = await service.probe();
      expect(out.install).not.toHaveProperty('runnable');
      expect(out.install).not.toHaveProperty('argv');
    });

    it('path is omitted from external-login on the wire and no token leaks', async () => {
      await mkdir(join(home(), '.codex'), { recursive: true });
      await writeFile(
        join(home(), '.codex', 'auth.json'),
        JSON.stringify({
          tokens: { access_token: FAKE_ACCESS, refresh_token: FAKE_REFRESH, id_token: FAKE_ID },
        }),
      );
      const { impl } = makeFetch({});
      const { service, secrets } = make({ fetchFn: impl });

      const out = await service.probe();

      const login = out.candidates.find((c) => c.kind === 'external-login');
      expect(login).toEqual({ kind: 'external-login', source: 'codex-cli', provider: 'codex' });
      expect(login).not.toHaveProperty('path');
      const wire = JSON.stringify(out);
      expect(wire).not.toContain(home());
      for (const secret of [FAKE_ACCESS, FAKE_REFRESH, FAKE_ID]) {
        expect(wire).not.toContain(secret);
      }
      // Reporting a login never copies it.
      expect(await secrets.get('providers/codex/tokens')).toBeNull();
    });

    it('finds brew through Storage (PATH lookup) and offers the brew command on macOS', async () => {
      const storage = new InMemoryStorage();
      await storage.mkdir('/opt/homebrew/bin');
      await storage.write('/opt/homebrew/bin/brew', '#!/bin/sh');
      vi.stubEnv('PATH', ['/usr/bin', '/opt/homebrew/bin'].join(delimiter));
      try {
        const { impl } = makeFetch({});
        const { service } = make({
          fetchFn: impl,
          storage,
          probeHost: host({ platform: 'darwin' }),
        });
        const out = await service.probe();
        expect(out.install.command).toBe('brew install ollama && brew services start ollama');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('importCodexLogin', () => {
    async function writeCodex(shape: 'ok' | 'bad') {
      await mkdir(join(home(), '.codex'), { recursive: true });
      await writeFile(
        join(home(), '.codex', 'auth.json'),
        JSON.stringify(
          shape === 'ok'
            ? {
                tokens: {
                  access_token: FAKE_ACCESS,
                  refresh_token: FAKE_REFRESH,
                  id_token: FAKE_ID,
                },
              }
            : { tokens: { access_token: FAKE_ACCESS } },
        ),
      );
    }

    it('imports to the vault and returns only model ids, never a token', async () => {
      await writeCodex('ok');
      const { impl } = makeFetch({
        'chatgpt.com': () => json({ models: [{ id: 'gpt-5.5-codex' }] }),
      });
      const { service, secrets } = make({ fetchFn: impl });

      const out = await service.importCodexLogin({ source: 'codex-cli' });

      expect(out).toEqual({ ok: true, models: ['gpt-5.5-codex'] });
      expect(await secrets.get('providers/codex/tokens')).not.toBeNull();
      const wire = JSON.stringify(out);
      for (const secret of [FAKE_ACCESS, FAKE_REFRESH, FAKE_ID]) {
        expect(wire).not.toContain(secret);
      }
    });

    it('absent file → { ok:false, code:"absent" }', async () => {
      const { service } = make({});
      expect(await service.importCodexLogin({ source: 'hermes' })).toEqual({
        ok: false,
        code: 'absent',
      });
    });

    it('a file missing a token → invalid_shape, and nothing is stored', async () => {
      await writeCodex('bad');
      const { service, secrets } = make({});
      expect(await service.importCodexLogin({ source: 'codex-cli' })).toEqual({
        ok: false,
        code: 'invalid_shape',
      });
      expect(await secrets.get('providers/codex/tokens')).toBeNull();
    });
  });
});
