import { closeSync, type FSWatcher, fstatSync, openSync, readSync, watch } from 'node:fs';
import { join } from 'node:path';
import { isAlive, loadRegistry } from './registry';

export type WatchMatch = {
  pattern: string;
  line: string;
  stream: 'stdout' | 'stderr';
  elapsed_ms: number;
};

type CompiledPattern = { raw: string; re: RegExp | null };

export interface WatchConfig {
  id: string;
  pid: number;
  dataDir: string;
  logFiles: Array<{ path: string; label: 'stdout' | 'stderr' }>;
  compiled: CompiledPattern[];
  stopFirst: boolean;
  timeoutMs: number;
  abortSignal: AbortSignal;
  onMatch: (match: WatchMatch) => void;
}

export interface WatchResult {
  matched: boolean;
  matches?: WatchMatch[];
  timed_out?: boolean;
  process_exited?: boolean;
  exit_code?: number;
}

const WAIT_POLL_MS = 200;

export function compilePatterns(
  patterns: string[],
): { compiled: CompiledPattern[] } | { error: string } {
  const compiled: CompiledPattern[] = [];
  for (const p of patterns) {
    if (p.startsWith('/') && p.endsWith('/') && p.length > 1) {
      try {
        compiled.push({ raw: p, re: new RegExp(p.slice(1, -1)) });
      } catch {
        return { error: `INVALID_PATTERN: "${p}" is not a valid regex` };
      }
    } else {
      compiled.push({ raw: p, re: null });
    }
  }
  return { compiled };
}

export function buildLogFiles(
  dataDir: string,
  id: string,
  streams: 'stdout' | 'stderr' | 'both',
): Array<{ path: string; label: 'stdout' | 'stderr' }> {
  const logFiles: Array<{ path: string; label: 'stdout' | 'stderr' }> = [];
  if (streams === 'stdout' || streams === 'both') {
    logFiles.push({ path: join(dataDir, 'processes', id, 'stdout.log'), label: 'stdout' });
  }
  if (streams === 'stderr' || streams === 'both') {
    logFiles.push({ path: join(dataDir, 'processes', id, 'stderr.log'), label: 'stderr' });
  }
  return logFiles;
}

export function watchLogs(config: WatchConfig): Promise<WatchResult> {
  const { id, pid, dataDir, logFiles, compiled, stopFirst, timeoutMs, abortSignal, onMatch } =
    config;
  const startTime = Date.now();
  const matches: WatchMatch[] = [];

  return new Promise<WatchResult>((resolve) => {
    let resolved = false;
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let livenessInterval: ReturnType<typeof setInterval> | undefined;

    const offsets = new Map<string, number>();
    const pending = new Map<string, string>();
    for (const lf of logFiles) {
      offsets.set(lf.path, 0);
    }

    function closeAll() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
      watchers.length = 0;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (livenessInterval !== undefined) {
        clearInterval(livenessInterval);
        livenessInterval = undefined;
      }
    }

    function finish(result: WatchResult) {
      if (resolved) return;
      resolved = true;
      closeAll();
      resolve(result);
    }

    function flushPending() {
      for (const lf of logFiles) {
        const rem = pending.get(lf.path) ?? '';
        if (rem.length === 0) continue;
        pending.set(lf.path, '');
        for (const pat of compiled) {
          const hit = pat.re ? pat.re.test(rem) : rem.includes(pat.raw);
          if (hit) {
            const m: WatchMatch = {
              pattern: pat.raw,
              line: rem,
              stream: lf.label,
              elapsed_ms: Date.now() - startTime,
            };
            matches.push(m);
            onMatch(m);
            if (stopFirst) {
              finish({ matched: true, matches });
              return;
            }
            break;
          }
        }
        if (resolved) return;
      }
    }

    function checkLiveness() {
      if (resolved) return;
      if (!isAlive(pid)) {
        for (const lf of logFiles) {
          readNewLines(lf.path, lf.label);
          if (resolved) return;
        }
        flushPending();
        if (resolved) return;
        const current = loadRegistry(dataDir)[id];
        finish({
          matched: matches.length > 0,
          ...(matches.length > 0 && { matches }),
          process_exited: true,
          exit_code: current?.exitCode,
        });
      }
    }

    function readNewLines(filePath: string, label: 'stdout' | 'stderr') {
      let fd: number;
      try {
        fd = openSync(filePath, 'r');
      } catch {
        return;
      }
      try {
        const fileSize = fstatSync(fd).size;
        const offset = offsets.get(filePath) ?? 0;
        if (fileSize > offset) {
          const len = fileSize - offset;
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, offset);
          offsets.set(filePath, fileSize);

          const raw = (pending.get(filePath) ?? '') + buf.toString('utf8');
          const parts = raw.split('\n');
          const remainder = parts.pop() ?? '';
          pending.set(filePath, remainder);
          const lines = parts;

          for (const line of lines) {
            for (const pat of compiled) {
              const hit = pat.re ? pat.re.test(line) : line.includes(pat.raw);
              if (hit) {
                const m: WatchMatch = {
                  pattern: pat.raw,
                  line,
                  stream: label,
                  elapsed_ms: Date.now() - startTime,
                };
                matches.push(m);
                onMatch(m);
                if (stopFirst) {
                  finish({ matched: true, matches });
                  return;
                }
                break;
              }
            }
            if (resolved) return;
          }
        }
      } finally {
        closeSync(fd);
      }
    }

    for (const lf of logFiles) {
      readNewLines(lf.path, lf.label);
      if (resolved) return;
    }

    for (const lf of logFiles) {
      try {
        const watcher = watch(lf.path, { persistent: false }, (event) => {
          if (resolved) return;
          if (abortSignal.aborted) {
            finish({ matched: false });
            return;
          }
          if (event === 'rename') {
            offsets.set(lf.path, 0);
          }
          if (event === 'change' || event === 'rename') {
            readNewLines(lf.path, lf.label);
          }
        });
        watchers.push(watcher);
      } catch {
        // log file may not exist yet — not fatal
      }
    }

    for (const lf of logFiles) {
      readNewLines(lf.path, lf.label);
      if (resolved) return;
    }

    livenessInterval = setInterval(() => {
      if (resolved) return;
      for (const lf of logFiles) {
        readNewLines(lf.path, lf.label);
        if (resolved) return;
      }
      checkLiveness();
    }, WAIT_POLL_MS);

    timer = setTimeout(() => {
      finish({
        matched: matches.length > 0,
        ...(matches.length > 0 && { matches }),
        timed_out: true,
      });
    }, timeoutMs);

    if (abortSignal.aborted) {
      finish({ matched: false });
      return;
    }
    abortSignal.addEventListener(
      'abort',
      () => {
        finish({ matched: false });
      },
      { once: true },
    );
  });
}
