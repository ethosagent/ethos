import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  ContextInjector,
  HookRegistry,
  InjectionResult,
  PersonalityRegistry,
  PromptContext,
  Storage,
  ToolEndWithPathPayload,
} from '@ethosagent/types';
import { sanitize } from './prompt-injection-guard';

// Files checked in order — first match wins for the root layer (static mode).
// Progressive mode walks every directory between the project root and the
// touched file, injecting whichever discovery files are present.
const DEFAULT_DISCOVERY_FILES = ['AGENTS.md', 'CLAUDE.md', 'SOUL.md'];
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_CAP_TOTAL_CHARS = 20_000;

interface CacheEntry {
  mtime: number;
  content: string;
}

/** A single context layer we've discovered. Tracked per session so we
 *  re-inject on subsequent turns and can apply the cap budget. */
interface DiscoveredLayer {
  /** Absolute path to the discovered file. */
  path: string;
  /** Display label — relative to workingDir when possible. */
  label: string;
  /** Cached body (post-sanitize). */
  content: string;
  /** Insertion order — used to drop oldest when cap is exceeded. */
  seq: number;
}

interface SessionState {
  /** Insertion-ordered map keyed by absolute path. */
  layers: Map<string, DiscoveredLayer>;
  /** Monotonic sequence for layer ordering. */
  nextSeq: number;
}

export interface FileContextInjectorOptions {
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
  /** When provided, the injector subscribes to `tool_end_with_path` so it can
   *  discover sub-AGENTS.md as the agent navigates. Without this, only the
   *  root-level layer is loaded (static mode). */
  hooks?: HookRegistry;
  /** Used to resolve the active personality's `context_layering` config at
   *  hook-fire time. */
  personalities?: PersonalityRegistry;
}

export class FileContextInjector implements ContextInjector {
  readonly id = 'file-context';
  readonly priority = 90;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly storage: Storage;
  private readonly personalities?: PersonalityRegistry;
  /** Per-session discovered layers. Keyed by sessionId; cleared lazily. */
  private readonly sessionLayers = new Map<string, SessionState>();

  constructor(opts: FileContextInjectorOptions = {}) {
    this.storage = opts.storage ?? new FsStorage();
    if (opts.personalities) this.personalities = opts.personalities;
    if (opts.hooks) {
      opts.hooks.registerVoid('tool_end_with_path', async (payload) => {
        await this.handleToolPath(payload);
      });
    }
  }

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    const cwd = ctx.workingDir;
    if (!cwd) return null;

    const cfg = this.resolveLayeringConfig(ctx.personalityId);
    if (cfg.mode === 'off') return null;

    const discoveryFiles = cfg.discovery_files ?? DEFAULT_DISCOVERY_FILES;
    const sections: string[] = [];

    // Root layer — static behavior (always on unless mode='off').
    for (const filename of discoveryFiles) {
      const content = await this.readCached(join(cwd, filename));
      if (content) {
        sections.push(`### ${filename}\n\n${sanitize(content.trim())}`);
      }
    }

    // Progressive layers — discovered via tool_end_with_path subscription.
    if (cfg.mode === 'progressive') {
      const state = this.sessionLayers.get(ctx.sessionId);
      if (state) {
        for (const layer of state.layers.values()) {
          sections.push(`### ${layer.label}\n\n${layer.content}`);
        }
        if (!ctx.meta) ctx.meta = {};
        ctx.meta.discovered_context_layers = [...state.layers.values()].map((l) => l.label);
      }
    }

    if (sections.length === 0) return null;

    return {
      content: `## Project Context\n\n${sections.join('\n\n')}`,
      position: 'append',
    };
  }

  // -------------------------------------------------------------------------
  // E5 — Progressive discovery internals
  // -------------------------------------------------------------------------

  private async handleToolPath(payload: ToolEndWithPathPayload): Promise<void> {
    const cfg = this.resolveLayeringConfig(payload.personalityId);
    if (cfg.mode !== 'progressive') return;

    const root = payload.workingDir;
    if (!root) return;
    const targetAbs = isAbsolute(payload.filePath)
      ? normalize(payload.filePath)
      : resolve(root, payload.filePath);

    // Only walk inside the project root — refuse to surface AGENTS.md from
    // arbitrary parent directories (could be unrelated repos sitting next to
    // ours and is a privacy / accuracy hazard).
    if (!isWithin(root, targetAbs)) return;

    const discoveryFiles = cfg.discovery_files ?? DEFAULT_DISCOVERY_FILES;
    const maxDepth = cfg.max_depth ?? DEFAULT_MAX_DEPTH;
    const capChars = cfg.cap_total_chars ?? DEFAULT_CAP_TOTAL_CHARS;

    const dirs = walkUp(root, dirname(targetAbs), maxDepth);
    const state = this.getOrCreateState(payload.sessionId);

    for (const dir of dirs) {
      // Skip the root — already covered by the static layer in inject().
      if (dir === root) continue;
      for (const filename of discoveryFiles) {
        const filePath = join(dir, filename);
        if (state.layers.has(filePath)) continue;
        const content = await this.readCached(filePath);
        if (!content) continue;
        const label = relativeLabel(root, filePath);
        state.layers.set(filePath, {
          path: filePath,
          label,
          content: sanitize(content.trim()),
          seq: state.nextSeq++,
        });
      }
    }

    // Cap discipline: drop oldest layers when total exceeds budget.
    enforceCap(state, capChars);
  }

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessionLayers.get(sessionId);
    if (!state) {
      state = { layers: new Map(), nextSeq: 0 };
      this.sessionLayers.set(sessionId, state);
    }
    return state;
  }

  private resolveLayeringConfig(
    personalityId: string | undefined,
  ): NonNullable<import('@ethosagent/types').PersonalityConfig['context_layering']> {
    const p = personalityId ? this.personalities?.get(personalityId) : undefined;
    return p?.context_layering ?? { mode: 'static' };
  }

  /** Visible for tests — returns a snapshot of discovered layer labels. */
  getDiscoveredLayers(sessionId: string): string[] {
    const state = this.sessionLayers.get(sessionId);
    if (!state) return [];
    return [...state.layers.values()].map((l) => l.label);
  }

  private async readCached(filePath: string): Promise<string | null> {
    const mtimeMs = await this.storage.mtime(filePath);
    if (mtimeMs === null) return null;
    const cached = this.cache.get(filePath);
    if (cached && cached.mtime === mtimeMs) return cached.content;

    const content = await this.storage.read(filePath);
    if (content === null) return null;
    this.cache.set(filePath, { mtime: mtimeMs, content });
    return content;
  }
}

// True when `child` is `root` or a descendant of `root`. Both paths must be
// absolute and normalized.
function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  const rootWithSep = root.endsWith('/') ? root : `${root}/`;
  return child.startsWith(rootWithSep);
}

// Walk up from `start` to `root`, capped by `maxDepth` levels. Includes both
// endpoints. The closest directory comes first so deeper layers are appended
// last in injection order.
function walkUp(root: string, start: string, maxDepth: number): string[] {
  const out: string[] = [];
  let cur = start;
  for (let i = 0; i <= maxDepth; i++) {
    out.push(cur);
    if (cur === root) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

function relativeLabel(root: string, abs: string): string {
  const rootWithSep = root.endsWith('/') ? root : `${root}/`;
  return abs.startsWith(rootWithSep) ? abs.slice(rootWithSep.length) : abs;
}

function enforceCap(state: SessionState, capChars: number): void {
  let total = 0;
  for (const layer of state.layers.values()) total += layer.content.length;
  if (total <= capChars) return;
  // Drop oldest (lowest seq) until we fit. Map iteration is insertion order,
  // and we only ever push to the end, so this is already correct.
  for (const [path, layer] of state.layers) {
    if (total <= capChars) break;
    state.layers.delete(path);
    total -= layer.content.length;
  }
}
