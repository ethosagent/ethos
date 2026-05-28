import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanInstalledPlugins } from '@ethosagent/plugin-loader';
import { loadMcpConfig } from '@ethosagent/tools-mcp';

function spawnNpm(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks = [];
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        reject(new Error(stderr || `npm exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}
export class PluginsService {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  async install(packageSpec) {
    const dir = join(this.opts.dataDir, 'plugins');
    await mkdir(dir, { recursive: true });
    await spawnNpm(['install', '--prefix', dir, '--ignore-scripts', '--no-audit', packageSpec]);
  }
  async uninstall(pluginId) {
    const dir = join(this.opts.dataDir, 'plugins');
    await spawnNpm(['uninstall', '--prefix', dir, pluginId]);
  }
  async setCredential(pluginId, key, value) {
    if (!this.opts.pluginLoader) throw new Error('Plugin loader not available');
    await this.opts.pluginLoader.setCredential(pluginId, key, value);
  }
  async getCredentialMeta(pluginId, key) {
    if (!this.opts.pluginLoader) return null;
    return this.opts.pluginLoader.getCredentialMeta(pluginId, key);
  }
  async listCredentialKeys(pluginId) {
    if (!this.opts.pluginLoader) return [];
    const keys = await this.opts.pluginLoader.listCredentialKeys(pluginId);
    return keys.map((k) => ({
      key: k.key,
      label: k.label,
      type: k.type,
      description: k.description ?? null,
      refreshHint: k.refreshHint ?? null,
      required: k.required ?? null,
      isSet: k.isSet,
      updatedAt: k.updatedAt,
    }));
  }
  async list() {
    const [manifests, mcpRaw] = await Promise.all([
      scanInstalledPlugins({
        userDir: this.opts.dataDir,
        storage: this.opts.storage,
        ...(this.opts.workingDir ? { workingDir: this.opts.workingDir } : {}),
      }),
      loadMcpConfig(this.opts.storage),
    ]);
    const mcpServers = mcpRaw
      .filter(isValidMcpServer)
      .map(toWireMcpServer)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { plugins: manifests.map(toWirePlugin), mcpServers };
  }
  async getPageSpec(pluginId) {
    return this.opts.pluginPages?.get(pluginId) ?? null;
  }
  async invokeToolForPage(pluginId, toolName, args, toolRegistry) {
    // Verify the tool is declared in this plugin's page spec to prevent
    // arbitrary tool execution through the page endpoint.
    const spec = this.opts.pluginPages?.get(pluginId);
    if (!spec) {
      return { ok: false, value: '', error: `No page spec registered for plugin "${pluginId}"` };
    }
    const allowedTools = new Set();
    for (const section of spec.sections) {
      if ('toolName' in section && typeof section.toolName === 'string') {
        allowedTools.add(section.toolName);
      }
    }
    if (!allowedTools.has(toolName)) {
      return {
        ok: false,
        value: '',
        error: `Tool "${toolName}" is not declared in plugin "${pluginId}" page spec`,
      };
    }
    // Verify the tool is owned by the requesting plugin. A plugin's page spec
    // can only reference tools that the same plugin registered — not tools from
    // other plugins or built-in tools.
    const ownerPluginId = this.opts.pluginToolOwnership?.get(toolName);
    if (ownerPluginId !== pluginId) {
      return {
        ok: false,
        value: '',
        error: `Tool "${toolName}" is not owned by plugin "${pluginId}"`,
      };
    }
    if (!toolRegistry) {
      return { ok: false, value: '', error: 'Tool registry not available' };
    }
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      return { ok: false, value: '', error: `Tool "${toolName}" not found` };
    }
    const MAX_PAGE_RESULT_CHARS = 80_000;
    try {
      const result = await tool.execute(args ?? {}, {
        sessionId: `page:${pluginId}`,
        sessionKey: `page:${pluginId}`,
        platform: 'web-page',
        workingDir: this.opts.dataDir,
        currentTurn: 0,
        messageCount: 0,
        abortSignal: AbortSignal.timeout(30_000),
        emit: () => {},
        resultBudgetChars: MAX_PAGE_RESULT_CHARS,
      });
      if (result.ok) {
        const value =
          result.value.length > MAX_PAGE_RESULT_CHARS
            ? `${result.value.slice(0, MAX_PAGE_RESULT_CHARS)}\n[truncated]`
            : result.value;
        return {
          ok: true,
          value,
          ...(result.structured ? { structured: result.structured } : {}),
        };
      }
      return { ok: false, value: '', error: result.error };
    } catch (err) {
      return { ok: false, value: '', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
function toWirePlugin(m) {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    source: m.source,
    path: m.path,
    pluginContractMajor: m.pluginContractMajor,
  };
}
function isValidMcpServer(entry) {
  if (typeof entry.name !== 'string') return false;
  return (
    entry.transport === 'stdio' ||
    entry.transport === 'sse' ||
    entry.transport === 'streamable-http'
  );
}
function toWireMcpServer(entry) {
  return {
    name: entry.name,
    transport: entry.transport,
    command: typeof entry.command === 'string' ? entry.command : null,
    url: typeof entry.url === 'string' ? entry.url : null,
    auth_status: null,
    created_via: entry.created_via ?? null,
    mcpResultLimitChars: entry.mcpResultLimitChars ?? null,
    deprecated: entry.transport === 'sse',
  };
}
