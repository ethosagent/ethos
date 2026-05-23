import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-contract';
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
        provider: 'anthropic' | 'openai' | 'ollama';
        apiKey: string;
        baseUrl?: string;
      },
    ) => {
      try {
        if (req.provider === 'ollama') {
          const baseUrl = req.baseUrl || 'http://localhost:11434';
          const res = await fetch(`${baseUrl}/api/tags`);
          if (!res.ok) {
            return {
              valid: false,
              completionTested: false,
              error: 'Cannot reach Ollama',
              errorCode: 'other' as const,
            };
          }
          const data = (await res.json()) as { models?: Array<{ name: string }> };
          return {
            valid: true,
            completionTested: false,
            models: (data.models || []).map((m: { name: string }) => m.name),
          };
        }

        if (req.provider === 'anthropic') {
          const modelsRes = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': req.apiKey,
              'anthropic-version': '2023-06-01',
            },
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
      _event,
      req: {
        provider: string;
        model: string;
        apiKey: string;
        personalityId: string;
      },
    ) => {
      const validProviders = ['anthropic', 'openai', 'ollama'];
      const validPersonalities = ['researcher', 'engineer', 'operator', 'coach'];

      if (!validProviders.includes(req.provider)) {
        return { success: false, error: 'Invalid provider' };
      }
      if (!req.model || typeof req.model !== 'string') {
        return { success: false, error: 'Invalid model' };
      }
      if (!validPersonalities.includes(req.personalityId)) {
        return { success: false, error: 'Invalid personality' };
      }

      if (req.apiKey) {
        await setKeychainValue('api-key', req.apiKey);
      }

      store.set('provider', req.provider as 'anthropic' | 'openai' | 'ollama');
      store.set('model', req.model);
      store.set('personalityId', req.personalityId);
      store.set('onboardingComplete', true);

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
    try {
      const res = await fetch(`http://localhost:${req.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return { healthy: res.ok };
    } catch {
      return { healthy: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS['theme:get'], () => {
    return store.get('theme', 'dark');
  });
}
