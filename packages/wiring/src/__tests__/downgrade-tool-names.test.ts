// Drift gate for the Ch.3d post-untrusted-read downgrade default tool list.
//
// `resolveDowngradedTools('auto')` returns the names that get blocked for
// the next turn after an `outputIsUntrusted` result. If a tool is renamed
// in its package and the safety-injection default list isn't updated in
// lockstep, the security control silently fails open. This test asserts
// that every name in the default list still resolves to a real registered
// tool — i.e. the gate catches RENAMES and REMOVALS.
//
// What this gate does NOT catch:
//   - a NEW dangerous tool that should be in the downgrade set but isn't.
//     Coverage of that case requires a separate classification source
//     (e.g. a `dangerous: true` marker on the tool itself), which Ch.3
//     deliberately doesn't ship — the dangerous list lives in policy
//     code, not in tool definitions.
//
// On failure, fix one of:
//   - tool was renamed: update DEFAULT_DOWNGRADED_TOOLS in
//     packages/safety/injection/src/downgrade.ts
//   - tool was removed: remove the entry from the default list
//
// Tests live in wiring (not safety-injection) because only this layer
// imports every tools-* package; core/safety-injection deliberately
// don't depend on extensions.

import { resolveDowngradedTools } from '@ethosagent/safety-injection';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createCodeTools } from '@ethosagent/tools-code';
import { createFileTools } from '@ethosagent/tools-file';
import { createProcessTools } from '@ethosagent/tools-process';
import { createTerminalTools } from '@ethosagent/tools-terminal';
import { createWebTools } from '@ethosagent/tools-web';
import { describe, expect, it } from 'vitest';

// Minimal stub for createCodeTools — the factory only reads `isAvailable()`
// at registration time. Avoid `new DockerSandbox()` here so this drift
// check stays decoupled from sandbox initialization details.
type SandboxLike = Parameters<typeof createCodeTools>[0];
const sandboxStub: SandboxLike = {
  isAvailable: () => false,
  run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
} as unknown as SandboxLike;

describe('Ch.3d default downgrade list — drift gate', () => {
  it('every name in the default `auto` set is the name of an actual registered tool', () => {
    const registered = new Set<string>();
    for (const t of createFileTools()) registered.add(t.name);
    for (const t of createTerminalTools()) registered.add(t.name);
    for (const t of createWebTools()) registered.add(t.name);
    for (const t of createProcessTools('/tmp/ethos-test')) registered.add(t.name);
    for (const t of createCodeTools(sandboxStub)) registered.add(t.name);
    for (const t of createBrowserTools({})) registered.add(t.name);

    const downgraded = [...resolveDowngradedTools('auto')];
    const missing = downgraded.filter((name) => !registered.has(name));

    expect(
      missing,
      `Default downgrade list contains tool names that are no longer registered: ${missing.join(', ')}. Update packages/safety/injection/src/downgrade.ts.`,
    ).toEqual([]);
  });
});
