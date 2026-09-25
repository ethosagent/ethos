// R4 (openclaw-9.6-gaps) — the shipped compose files must default the state
// directory to a NAMED volume. A bind mount on Docker Desktop is virtiofs /
// gRPC-FUSE (macOS) or 9p (Windows), where SQLite's locking is unsafe and the
// databases in the state dir can corrupt. `ETHOS_DATA_DIR` may still name a
// host path (an explicit, documented opt-in); the DEFAULT may not.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const DOCKER_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'docker');
const STATE_PATH = /^\$\{ETHOS_STATE_DIR:-\/home\/ethos\/\.ethos\}$|^\/home\/ethos\/\.ethos$/;

/** Resolve `${VAR:-default}` the way compose does when VAR is unset. */
function withDefaults(value: string): string {
  return value.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, '$1');
}

/** Split `source:target[:mode]` on the colons outside `${…}` interpolations. */
function splitMount(mount: string): [string, string] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of mount) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ':' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return [parts[0] ?? '', parts[1] ?? ''];
}

interface ComposeFile {
  services: Record<string, { volumes?: string[] }>;
  volumes?: Record<string, unknown>;
}

describe.each(['docker-compose.yml', 'docker-compose.single.yml'])('%s state volume', (file) => {
  const compose = parse(readFileSync(join(DOCKER_DIR, file), 'utf8')) as ComposeFile;

  it('mounts the state dir from a declared named volume by default, never a host path', () => {
    let stateMounts = 0;
    for (const [name, service] of Object.entries(compose.services)) {
      for (const mount of service.volumes ?? []) {
        const [rawSource, target] = splitMount(mount);
        if (!STATE_PATH.test(target)) continue;
        stateMounts++;
        const source = withDefaults(rawSource);
        // Compose reads a source containing `/` or starting with `.` or `~` as
        // a bind mount; anything else is a named volume.
        expect(source, `${name}: state mount source`).not.toMatch(/[/~]|^\./);
        expect(compose.volumes ?? {}, `${name}: volume ${source} declared`).toHaveProperty(source);
      }
    }
    expect(stateMounts).toBeGreaterThan(0);
  });
});
