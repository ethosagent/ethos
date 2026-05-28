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
