import type { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-contract';
import { startBackend } from './backend';
import { setKeychainValue } from './keychain';
import { store } from './store';

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS['onboarding:state'], () => {
    return { configured: store.get('onboardingComplete', false) };
  });

  ipcMain.handle(
    IPC_CHANNELS['onboarding:validateProvider'],
    async (
      _event,
      req: {
        provider: 'anthropic' | 'openai' | 'openrouter' | 'azure';
        apiKey: string;
        baseUrl?: string;
        model?: string;
      },
    ) => {
      try {
        if (req.provider === 'anthropic') {
          const modelsRes = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': req.apiKey,
              'anthropic-version': '2023-06-01',
            },
            signal: AbortSignal.timeout(15000),
          });
          if (modelsRes.status === 401) {
            return {
              valid: false,
              completionTested: false,
              error: 'API key invalid — check and re-enter.',
              errorCode: 'invalid_key' as const,
            };
          }
          if (modelsRes.status === 402 || modelsRes.status === 403) {
            return {
              valid: false,
              completionTested: false,
              error: 'Your account has no credits or limited access.',
              errorCode: 'no_credits' as const,
            };
          }

          const completionRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': req.apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (completionRes.status === 402) {
            return {
              valid: true,
              completionTested: false,
              error: 'Your API key is valid but your account has no credits.',
              errorCode: 'no_credits' as const,
            };
          }
          if (completionRes.status === 403) {
            return {
              valid: true,
              completionTested: false,
              error: "This model isn't available on your plan.",
              errorCode: 'model_not_found' as const,
            };
          }
          if (!completionRes.ok) {
            const errText = await completionRes.text();
            return {
              valid: true,
              completionTested: false,
              error: `API key validated, but a test message failed: ${errText}`,
              errorCode: 'other' as const,
            };
          }

          return {
            valid: true,
            completionTested: true,
            models: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
          };
        }

        if (req.provider === 'openai') {
          const modelsRes = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${req.apiKey}` },
            signal: AbortSignal.timeout(15000),
          });
          if (modelsRes.status === 401) {
            return {
              valid: false,
              completionTested: false,
              error: 'API key invalid — check and re-enter.',
              errorCode: 'invalid_key' as const,
            };
          }

          const completionRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${req.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (completionRes.status === 402 || completionRes.status === 429) {
            return {
              valid: true,
              completionTested: false,
              error: 'Your API key is valid but your account has no credits.',
              errorCode: 'no_credits' as const,
            };
          }
          if (!completionRes.ok) {
            const errText = await completionRes.text();
            return {
              valid: true,
              completionTested: false,
              error: `API key validated, but a test message failed: ${errText}`,
              errorCode: 'other' as const,
            };
          }

          return { valid: true, completionTested: true, models: ['gpt-4o', 'gpt-4o-mini', 'o3'] };
        }

        if (req.provider === 'openrouter') {
          const base = 'https://openrouter.ai/api/v1';
          const modelsRes = await fetch(`${base}/models`, {
            headers: { Authorization: `Bearer ${req.apiKey}` },
            signal: AbortSignal.timeout(15000),
          });
          if (modelsRes.status === 401) {
            return {
              valid: false,
              completionTested: false,
              error: 'API key invalid — check and re-enter.',
              errorCode: 'invalid_key' as const,
            };
          }
          const completionRes = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: req.model || 'openai/gpt-4o-mini',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (completionRes.status === 402 || completionRes.status === 429) {
            return {
              valid: true,
              completionTested: false,
              error: 'Your API key is valid but your account has no credits.',
              errorCode: 'no_credits' as const,
            };
          }
          return { valid: true, completionTested: completionRes.ok, models: [] };
        }

        if (req.provider === 'azure') {
          if (!req.baseUrl || !req.model) {
            return {
              valid: false,
              completionTested: false,
              error: 'Resource URL and deployment name are required.',
              errorCode: 'other' as const,
            };
          }
          const baseUrl = req.baseUrl.replace(/\/$/, '');
          const endpoint = `${baseUrl}/openai/deployments/${req.model}/chat/completions?api-version=2024-10-21`;
          try {
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'api-key': req.apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 1,
              }),
              signal: AbortSignal.timeout(15000),
            });
            if (res.status === 401 || res.status === 403) {
              return {
                valid: false,
                completionTested: false,
                error: 'API key invalid — check and re-enter.',
                errorCode: 'invalid_key' as const,
              };
            }
            if (res.status === 404) {
              return {
                valid: false,
                completionTested: false,
                error: 'Deployment not found — check the resource URL and deployment name.',
                errorCode: 'other' as const,
              };
            }
            if (!res.ok) {
              let detail = `HTTP ${res.status}`;
              try {
                const t = await res.text();
                if (t) detail = t;
              } catch {
                /* ignore */
              }
              return {
                valid: false,
                completionTested: false,
                error: `Azure request failed: ${detail}`,
                errorCode: 'other' as const,
              };
            }
            return { valid: true, completionTested: true, models: [req.model] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              valid: false,
              completionTested: false,
              error: `Cannot reach Azure endpoint: ${msg}`,
              errorCode: 'other' as const,
            };
          }
        }

        return {
          valid: false,
          completionTested: false,
          error: 'Unknown provider',
          errorCode: 'other' as const,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          valid: false,
          completionTested: false,
          error: message,
          errorCode: 'other' as const,
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['onboarding:complete'],
    async (
      event,
      req: {
        provider: string;
        model: string;
        apiKey: string;
        personalityId: string;
      },
    ) => {
      const validProviders = ['anthropic', 'openai', 'openrouter', 'azure'];
      const validPersonalities = ['researcher', 'engineer', 'operator', 'coach'];

      if (!validProviders.includes(req.provider)) {
        return { success: false, error: 'Invalid provider' };
      }
      if (!req.model || typeof req.model !== 'string') {
        return { success: false, error: 'Invalid model' };
      }
      if (!/^[a-zA-Z0-9._:/-]+$/.test(req.model)) {
        return { success: false, error: 'Invalid model name' };
      }
      if (!validPersonalities.includes(req.personalityId)) {
        return { success: false, error: 'Invalid personality' };
      }

      if (req.apiKey) {
        await setKeychainValue('api-key', req.apiKey);
      }

      const ethosDir = join(app.getPath('home'), '.ethos');
      mkdirSync(ethosDir, { recursive: true });

      if (req.apiKey) {
        const secretsDir = join(ethosDir, 'secrets');
        mkdirSync(secretsDir, { recursive: true });
        writeFileSync(join(secretsDir, 'api-key'), `${req.apiKey}\n`, { mode: 0o600 });
      }

      const lines = [
        'schemaVersion: 1',
        `provider: ${req.provider}`,
        `model: ${req.model}`,
        `personality: ${req.personalityId}`,
      ];
      if (req.apiKey) {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal YAML secrets ref, not a JS template
        lines.push('apiKey: ${secrets:api-key}');
      }
      writeFileSync(join(ethosDir, 'config.yaml'), `${lines.join('\n')}\n`);

      store.set('provider', req.provider as 'anthropic' | 'openai' | 'openrouter' | 'azure');
      store.set('model', req.model);
      store.set('personalityId', req.personalityId);
      store.set('onboardingComplete', true);

      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        win.setResizable(true);
        win.setSize(1200, 800);
        win.center();
      }
      (app as unknown as EventEmitter).emit('ethos:onboarding-complete');
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS['personalities:list'], () => {
    return [
      {
        id: 'researcher',
        name: 'Researcher',
        description: 'Deep analysis, research, and synthesis',
        accent: '#4A9EFF',
        isBuiltin: true,
      },
      {
        id: 'engineer',
        name: 'Engineer',
        description: 'Code, architecture, debugging',
        accent: '#4ADE80',
        isBuiltin: true,
      },
      {
        id: 'operator',
        name: 'Assistant',
        description: 'General-purpose help with anything',
        accent: '#94A3B8',
        isBuiltin: true,
      },
      {
        id: 'coach',
        name: 'Coach',
        description: 'Guidance, encouragement, clarity',
        accent: '#E879F9',
        isBuiltin: true,
      },
    ];
  });

  ipcMain.handle(IPC_CHANNELS['health:check'], async (_event, req: { port: number }) => {
    const port = Number(req.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { healthy: false };
    }
    try {
      const res = await fetch(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      return { healthy: res.status < 600 };
    } catch {
      return { healthy: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS['backend:port'], () => {
    return store.get('backendPort', 3001);
  });

  ipcMain.handle(IPC_CHANNELS['backend:start'], (_event, req: { port: number }) => {
    const port = Number(req.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { started: false };
    }
    startBackend(port);
    return { started: true };
  });

  ipcMain.handle(IPC_CHANNELS['theme:get'], () => {
    return store.get('theme', 'dark');
  });

  ipcMain.handle(IPC_CHANNELS['advancedMode:get'], () => {
    return store.get('advancedMode', false);
  });

  ipcMain.handle(IPC_CHANNELS['advancedMode:set'], (_event, req: { enabled: boolean }) => {
    store.set('advancedMode', req.enabled);
    return { ok: true };
  });
}
