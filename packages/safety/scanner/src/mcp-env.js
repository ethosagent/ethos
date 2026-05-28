import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PASSTHROUGH = new Set(['PATH', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL']);
// Matches KEY/TOKEN/SECRET/PASSWORD as whole words (separated by _ or string boundaries),
// e.g. API_KEY, MY_KEY_FILE, PASSWORD_HASH — but not KEYSTONE or MASTODON.
const CREDENTIAL_PATTERN = /(^|_)(KEY|TOKEN|SECRET|PASSWORD)($|_)/i;
/**
 * Build a minimal environment for an MCP subprocess.
 * - Passes only DEFAULT_PASSTHROUGH vars plus any in `extraPassthrough`
 * - Strips all vars matching *_KEY, *_TOKEN, *_SECRET, *_PASSWORD unless explicitly in extraPassthrough
 * - Sets HOME, TMPDIR, XDG_* to a per-server scratch directory
 */
export function buildMcpEnv(serverId, extraPassthrough = []) {
  const scratchDir = join(homedir(), '.ethos', 'mcp-runtime', serverId);
  const tmpDir = join(scratchDir, 'tmp');
  ensureScratchDir(scratchDir);
  ensureScratchDir(tmpDir);
  const allowed = new Set([...DEFAULT_PASSTHROUGH, ...extraPassthrough]);
  const explicitPassthrough = new Set(extraPassthrough);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) continue;
    // Strip credential vars unless skill explicitly declared them in extraPassthrough
    if (CREDENTIAL_PATTERN.test(key) && !explicitPassthrough.has(key)) continue;
    env[key] = value;
  }
  // Sanitized home — prevents reading ~/.aws, ~/.ssh, ~/.npmrc, etc.
  env.HOME = scratchDir;
  env.TMPDIR = tmpDir;
  env.XDG_CONFIG_HOME = join(scratchDir, '.config');
  env.XDG_DATA_HOME = join(scratchDir, '.local', 'share');
  env.XDG_CACHE_HOME = join(scratchDir, '.cache');
  return env;
}
function ensureScratchDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // ignore if already exists or permission error
  }
}
