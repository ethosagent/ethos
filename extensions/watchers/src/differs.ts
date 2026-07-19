// Deterministic per-kind differs. Each differ observes the target, compares
// against the persisted last-seen state, and reports whether a change
// happened plus the fresh state to persist. No LLM, no side effects beyond
// the observation itself — the manager owns state persistence and dispatch.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Storage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// State shapes — persisted as JSON at <watchersDir>/state/<id>.json
// ---------------------------------------------------------------------------

export interface FileWatcherState {
  kind: 'file';
  exists: boolean;
  mtime: number | null;
  hash: string | null;
}

export interface HttpWatcherState {
  kind: 'http';
  etag: string | null;
  hash: string;
}

export interface RssWatcherState {
  kind: 'rss';
  /** Seen item GUIDs, newest first, capped at MAX_SEEN_GUIDS. */
  seen: string[];
}

export interface ProcessWatcherState {
  kind: 'process';
  alive: boolean;
}

export type WatcherState =
  | FileWatcherState
  | HttpWatcherState
  | RssWatcherState
  | ProcessWatcherState;

/** Cap on the stored RSS seen-GUID set. */
export const MAX_SEEN_GUIDS = 500;

/**
 * Outcome of one differ observation.
 *
 * - `error` set → the observation failed (network error, probe failure).
 *   The caller logs it, keeps the prior state, and treats it as no change.
 * - `changed: false` with a `state` → first observation (seed) or a benign
 *   refresh; the caller persists only when there was no prior state.
 * - `changed: true` → a real transition; `summary` is a short deterministic
 *   description suitable for verbatim delivery.
 * - `state: null` with no error → nothing new to persist (e.g. HTTP 304).
 */
export interface DiffOutcome {
  changed: boolean;
  state: WatcherState | null;
  summary?: string;
  error?: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// file — mtime + sha256 content hash; appearing/disappearing is a change
// ---------------------------------------------------------------------------

export async function diffFile(
  target: string,
  prev: FileWatcherState | null,
  storage: Storage,
): Promise<DiffOutcome> {
  let mtime: number | null;
  let content: string | null;
  try {
    mtime = await storage.mtime(target);
    content = mtime === null ? null : await storage.read(target);
  } catch (err) {
    return { changed: false, state: null, error: errorMessage(err) };
  }
  const exists = content !== null;
  const hash = content === null ? null : sha256(content);
  const state: FileWatcherState = { kind: 'file', exists, mtime, hash };
  if (!prev) return { changed: false, state };

  if (prev.exists !== exists) {
    return {
      changed: true,
      state,
      summary: exists ? `file appeared: ${target}` : `file removed: ${target}`,
    };
  }
  if (prev.hash !== hash) {
    const mtimeLabel = mtime === null ? 'unknown' : new Date(mtime).toISOString();
    return { changed: true, state, summary: `file changed: ${target} (mtime ${mtimeLabel})` };
  }
  return { changed: false, state };
}

// ---------------------------------------------------------------------------
// http — GET with If-None-Match; change = ETag change or content-hash change
// ---------------------------------------------------------------------------

export async function diffHttp(
  target: string,
  prev: HttpWatcherState | null,
  fetchFn: typeof fetch,
): Promise<DiffOutcome> {
  let res: Response;
  try {
    res = await fetchFn(target, {
      method: 'GET',
      headers: prev?.etag ? { 'If-None-Match': prev.etag } : {},
      redirect: 'follow',
    });
  } catch (err) {
    return { changed: false, state: null, error: errorMessage(err) };
  }
  if (res.status === 304) return { changed: false, state: null };
  if (!res.ok) {
    return { changed: false, state: null, error: `HTTP ${res.status} from ${target}` };
  }
  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    return { changed: false, state: null, error: errorMessage(err) };
  }
  const etag = res.headers.get('etag');
  const hash = sha256(body);
  const state: HttpWatcherState = { kind: 'http', etag, hash };
  if (!prev) return { changed: false, state };

  const changed = hash !== prev.hash || (etag !== null && prev.etag !== null && etag !== prev.etag);
  if (!changed) return { changed: false, state };
  return { changed: true, state, summary: `HTTP target changed: ${target}` };
}

// ---------------------------------------------------------------------------
// rss — new item GUIDs (fall back to link, then title hash); seen set capped
// ---------------------------------------------------------------------------

interface FeedItem {
  guid: string;
  title: string;
}

function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m || m[1] === undefined) return null;
  const text = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  return text || null;
}

/** Parse RSS `<item>` / Atom `<entry>` blocks into `{ guid, title }` pairs. */
export function parseFeedItems(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi)].map(
    (m) => m[0],
  );
  return blocks.map((block) => {
    const title = tagText(block, 'title') ?? '(untitled)';
    const guid =
      tagText(block, 'guid') ?? tagText(block, 'id') ?? tagText(block, 'link') ?? sha256(block);
    return { guid, title };
  });
}

export async function diffRss(
  target: string,
  prev: RssWatcherState | null,
  fetchFn: typeof fetch,
): Promise<DiffOutcome> {
  let res: Response;
  try {
    res = await fetchFn(target, { method: 'GET', redirect: 'follow' });
  } catch (err) {
    return { changed: false, state: null, error: errorMessage(err) };
  }
  if (!res.ok) {
    return { changed: false, state: null, error: `HTTP ${res.status} from ${target}` };
  }
  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    return { changed: false, state: null, error: errorMessage(err) };
  }
  const items = parseFeedItems(body);
  const prevSeen = new Set(prev?.seen ?? []);
  const fresh = items.filter((i) => !prevSeen.has(i.guid));
  const seen = [...fresh.map((i) => i.guid), ...(prev?.seen ?? [])].slice(0, MAX_SEEN_GUIDS);
  const state: RssWatcherState = { kind: 'rss', seen };
  if (!prev) return { changed: false, state };
  if (fresh.length === 0) return { changed: false, state };

  const titles = fresh
    .slice(0, 5)
    .map((i) => i.title)
    .join('; ');
  const suffix = fresh.length > 5 ? '; …' : '';
  return {
    changed: true,
    state,
    summary: `${fresh.length} new RSS item${fresh.length === 1 ? '' : 's'}: ${titles}${suffix}`,
  };
}

// ---------------------------------------------------------------------------
// process — alive|dead; change = transition either way
// ---------------------------------------------------------------------------

/** Returns true when the observed process is alive. Injected for tests. */
export type ProcessProbe = (target: string) => Promise<boolean>;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgrepAlive(name: string): Promise<boolean> {
  return new Promise((resolveAlive) => {
    execFile('pgrep', ['-x', name], (err) => resolveAlive(!err));
  });
}

/**
 * Default probe: a numeric target is a PID (signal-0, matching
 * `extensions/tools-process`); a target that resolves to an existing file
 * is a pid-file (its content is the PID); anything else is a process name
 * checked via `pgrep -x`. This observes host processes — not `~/.ethos/`
 * data — so raw process APIs are fine here.
 */
export function createDefaultProcessProbe(storage: Storage): ProcessProbe {
  return async (target: string): Promise<boolean> => {
    const trimmed = target.trim();
    if (/^\d+$/.test(trimmed)) return pidAlive(Number(trimmed));
    if (await storage.exists(trimmed)) {
      const raw = (await storage.read(trimmed))?.trim() ?? '';
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      return pidAlive(pid);
    }
    return pgrepAlive(trimmed);
  };
}

export async function diffProcess(
  target: string,
  prev: ProcessWatcherState | null,
  probe: ProcessProbe,
): Promise<DiffOutcome> {
  let alive: boolean;
  try {
    alive = await probe(target);
  } catch (err) {
    return { changed: false, state: null, error: errorMessage(err) };
  }
  const state: ProcessWatcherState = { kind: 'process', alive };
  if (!prev) return { changed: false, state };
  if (prev.alive === alive) return { changed: false, state };
  return {
    changed: true,
    state,
    summary: `process ${target} is now ${alive ? 'alive' : 'dead'}`,
  };
}
