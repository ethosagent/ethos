import type { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { RetentionValues } from '../shared/ipc-contract';
import { IPC_CHANNELS } from '../shared/ipc-contract';
import { startBackend } from './backend';
import { getKeychainValue, setKeychainValue } from './keychain';
import { getLoginItem, setLoginItem } from './login-item';
import { testDiscord, testImap, testSmtp, testTelegram } from './platform-validator';
import { store } from './store';

const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-20250514'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  openrouter: [],
  azure: [],
  ollama: [],
};

function maskApiKey(value: string): string {
  if (value.length < 8) return '••••';
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

const ALLOWED_KEYCHAIN_KEYS = new Set(['api-key']);

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

  ipcMain.handle(IPC_CHANNELS['backend:authToken'], () => {
    try {
      const tokenPath = join(app.getPath('home'), '.ethos', 'web-token');
      const token = readFileSync(tokenPath, 'utf-8').trim();
      return token || null;
    } catch {
      return null;
    }
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
    const pref = store.get('theme', 'dark');
    if (pref === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    }
    return pref;
  });

  ipcMain.handle(IPC_CHANNELS['advancedMode:get'], () => {
    return store.get('advancedMode', false);
  });

  ipcMain.handle(IPC_CHANNELS['advancedMode:set'], (_event, req: { enabled: boolean }) => {
    store.set('advancedMode', req.enabled);
    return { ok: true };
  });

  ipcMain.handle(
    IPC_CHANNELS['theme:set'],
    (_event, req: { theme: 'dark' | 'light' | 'system' }) => {
      nativeTheme.themeSource = req.theme;
      store.set('theme', req.theme);

      const resolved =
        req.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : req.theme;

      const mainWindow = BrowserWindow.getFocusedWindow();
      if (mainWindow) {
        mainWindow.webContents.send('theme:changed', resolved);
      }

      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['keychain:set'],
    async (_event, req: { key: string; value: string }) => {
      if (!ALLOWED_KEYCHAIN_KEYS.has(req.key)) {
        return { ok: false };
      }
      await setKeychainValue(req.key, req.value);
      return { ok: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS['keychain:preview'], async (_event, req: { key: string }) => {
    if (!ALLOWED_KEYCHAIN_KEYS.has(req.key)) {
      return { preview: null };
    }
    const value = await getKeychainValue(req.key);
    if (!value) return { preview: null };
    return { preview: maskApiKey(value) };
  });

  ipcMain.handle(IPC_CHANNELS['config:get'], async () => {
    const apiKey = await getKeychainValue('api-key');
    return {
      provider: store.get('provider', 'anthropic'),
      model: store.get('model', 'claude-sonnet-4-20250514'),
      compressionModel: store.get('compressionModel'),
      visionModel: store.get('visionModel'),
      baseUrl: store.get('baseUrl'),
      apiKeyPreview: apiKey ? maskApiKey(apiKey) : null,
      memory: store.get('memory', 'markdown'),
      approvalMode: store.get('approvalMode', 'manual'),
      contextLayering: store.get('contextLayering', false),
      debugMode: store.get('debugMode', false),
      verbosity: store.get('verbosity', 'balanced'),
      messageFontSize: store.get('messageFontSize', 14),
      codeBlockFontSize: store.get('codeBlockFontSize', 13),
      theme: store.get('theme', 'dark'),
      retentionDays: store.get('retentionDays', 90),
      traceLogDays: store.get('traceLogDays', 30),
      observabilityDays: store.get('observabilityDays', 7),
      autoUpdate: store.get('autoUpdate', true),
      launchAtLogin: store.get('launchAtLogin', false),
      hasShownLoginItemHint: store.get('hasShownLoginItemHint', false),
      providers: PROVIDER_MODELS,
    };
  });

  ipcMain.handle(IPC_CHANNELS['config:update'], async (_event, req: Record<string, unknown>) => {
    const validProviders = new Set(['anthropic', 'openai', 'openrouter', 'azure', 'ollama']);
    const validMemory = new Set(['markdown', 'vector']);
    const validApproval = new Set(['manual', 'smart', 'off']);
    const validVerbosity = new Set(['concise', 'balanced', 'verbose']);
    const validTheme = new Set(['dark', 'light', 'system']);

    if (req.provider !== undefined) {
      if (!validProviders.has(req.provider as string))
        return { ok: false, error: 'Invalid provider' };
      store.set('provider', req.provider as string);
    }
    if (req.model !== undefined) {
      if (typeof req.model !== 'string' || !/^[a-zA-Z0-9._:/-]+$/.test(req.model))
        return { ok: false, error: 'Invalid model' };
      store.set('model', req.model);
    }
    if (req.compressionModel !== undefined) {
      if (req.compressionModel !== null && typeof req.compressionModel === 'string') {
        if (req.compressionModel === '') {
          store.delete('compressionModel' as never);
        } else {
          store.set('compressionModel', req.compressionModel);
        }
      }
    }
    if (req.visionModel !== undefined) {
      if (req.visionModel !== null && typeof req.visionModel === 'string') {
        if (req.visionModel === '') {
          store.delete('visionModel' as never);
        } else {
          store.set('visionModel', req.visionModel);
        }
      }
    }
    if (req.baseUrl !== undefined) {
      if (req.baseUrl !== null && typeof req.baseUrl === 'string') {
        if (req.baseUrl === '') {
          store.delete('baseUrl' as never);
        } else {
          store.set('baseUrl', req.baseUrl);
        }
      }
    }
    if (req.memory !== undefined) {
      if (!validMemory.has(req.memory as string))
        return { ok: false, error: 'Invalid memory backend' };
      store.set('memory', req.memory as 'markdown' | 'vector');
    }
    if (req.approvalMode !== undefined) {
      if (!validApproval.has(req.approvalMode as string))
        return { ok: false, error: 'Invalid approval mode' };
      store.set('approvalMode', req.approvalMode as 'manual' | 'smart' | 'off');
    }
    if (req.verbosity !== undefined) {
      if (!validVerbosity.has(req.verbosity as string))
        return { ok: false, error: 'Invalid verbosity' };
      store.set('verbosity', req.verbosity as 'concise' | 'balanced' | 'verbose');
    }
    if (req.theme !== undefined) {
      if (!validTheme.has(req.theme as string)) return { ok: false, error: 'Invalid theme' };
      const theme = req.theme as 'dark' | 'light' | 'system';
      store.set('theme', theme);
      nativeTheme.themeSource = theme;
    }

    // Boolean fields
    for (const key of [
      'contextLayering',
      'debugMode',
      'autoUpdate',
      'launchAtLogin',
      'hasShownLoginItemHint',
    ] as const) {
      if (req[key] !== undefined) {
        if (typeof req[key] !== 'boolean') return { ok: false, error: `Invalid ${key}` };
        store.set(key, req[key] as boolean);
      }
    }

    if (req.launchAtLogin !== undefined && typeof req.launchAtLogin === 'boolean') {
      try {
        await setLoginItem(req.launchAtLogin);
      } catch {
        // store preference is already saved; OS login item is best-effort
      }
    }

    // Numeric fields with clamping
    const numericFields: Array<{ key: string; min: number; max: number; storeKey: string }> = [
      { key: 'messageFontSize', min: 12, max: 18, storeKey: 'messageFontSize' },
      { key: 'codeBlockFontSize', min: 11, max: 15, storeKey: 'codeBlockFontSize' },
      { key: 'retentionDays', min: 7, max: 365, storeKey: 'retentionDays' },
      { key: 'traceLogDays', min: 1, max: 90, storeKey: 'traceLogDays' },
      { key: 'observabilityDays', min: 1, max: 30, storeKey: 'observabilityDays' },
    ];
    for (const { key, min, max, storeKey } of numericFields) {
      if (req[key] !== undefined) {
        const val = Number(req[key]);
        if (!Number.isFinite(val)) return { ok: false, error: `Invalid ${key}` };
        store.set(storeKey, Math.max(min, Math.min(max, Math.round(val))));
      }
    }

    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS['shell:openConfigFolder'], async () => {
    const ethosDir = join(app.getPath('home'), '.ethos');
    await shell.openPath(ethosDir);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS['export:data'], async () => {
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: `ethos-export-${Date.now()}.zip`,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      });

      if (result.canceled || !result.filePath) {
        return { ok: false, error: 'Cancelled' };
      }

      return { ok: false, error: 'Export not yet available' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(IPC_CHANNELS['retention:prune'], (_event, _req: RetentionValues) => {
    return { ok: true, freedBytes: 0 };
  });

  ipcMain.handle(
    IPC_CHANNELS['dialog:showOpen'],
    async (_event: unknown, req: { properties: string[] }) => {
      const allowed = new Set(['openDirectory', 'openFile', 'multiSelections']);
      const properties = req.properties.filter((p) => allowed.has(p)) as Array<
        'openDirectory' | 'openFile' | 'multiSelections'
      >;
      const result = await dialog.showOpenDialog({ properties });
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['dialog:showMessage'],
    async (
      _event: unknown,
      req: { type?: string; title?: string; message: string; buttons?: string[] },
    ) => {
      const allowedTypes = new Set(['none', 'info', 'error', 'question', 'warning']);
      const type =
        req.type && allowedTypes.has(req.type)
          ? (req.type as 'none' | 'info' | 'error' | 'question' | 'warning')
          : undefined;
      const buttons = req.buttons ? req.buttons.slice(0, 4) : undefined;
      const result = await dialog.showMessageBox({
        type,
        title: req.title,
        message: req.message,
        buttons,
      });
      return { response: result.response };
    },
  );

  ipcMain.handle(IPC_CHANNELS['shell:openExternal'], async (_event, req: { url: string }) => {
    if (!req.url.startsWith('https://')) {
      return { ok: false };
    }
    await shell.openExternal(req.url);
    return { ok: true };
  });

  ipcMain.handle(
    IPC_CHANNELS['dialog:showOpenDialog'],
    async (_event, req: { properties: string[] }) => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true, filePaths: [] };
      const allowed = new Set(['openFile', 'openDirectory', 'multiSelections']);
      const validated = req.properties.filter((p) => allowed.has(p));
      const result = await dialog.showOpenDialog(win, {
        properties: validated as Array<'openFile' | 'openDirectory' | 'multiSelections'>,
      });
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['file:save'],
    async (_event, req: { defaultName: string; content: string }) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: req.defaultName,
      });
      if (canceled || !filePath) return { ok: false };
      await writeFile(filePath, req.content, 'utf-8');
      return { ok: true, path: filePath };
    },
  );

  ipcMain.handle(IPC_CHANNELS['gateway:platformStatus'], async () => {
    return { telegram: false, slack: false, discord: false };
  });

  ipcMain.handle(IPC_CHANNELS['login-item:get'], async () => {
    return getLoginItem();
  });

  ipcMain.handle(IPC_CHANNELS['login-item:set'], async (_event, req: { enabled: boolean }) => {
    try {
      await setLoginItem(req.enabled);
      store.set('launchAtLogin', req.enabled);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(IPC_CHANNELS['platform:testTelegram'], async (_event, req: { token: string }) => {
    return testTelegram(req.token);
  });

  ipcMain.handle(IPC_CHANNELS['platform:testDiscord'], async (_event, req: { token: string }) => {
    return testDiscord(req.token);
  });

  ipcMain.handle(IPC_CHANNELS['platform:testImap'], async (_event, req) => {
    return testImap(req);
  });

  ipcMain.handle(IPC_CHANNELS['platform:testSmtp'], async (_event, req) => {
    return testSmtp(req);
  });
}
