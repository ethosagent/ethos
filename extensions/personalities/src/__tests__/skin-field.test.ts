import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

// Phase 3 — the personality loader picks up the optional `skin:` key
// from config.yaml. Surfaces read `personality.skin` and apply the
// resolution order (user pin > personality skin > engine default).

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-skin-field-test-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writePersonality(id: string, configYaml: string): Promise<void> {
  const dir = join(testDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), configYaml);
  await writeFile(join(dir, 'ETHOS.md'), `# ${id}`);
}

describe('Phase 3: personality skin field', () => {
  it('exposes config.yaml `skin:` on PersonalityConfig', async () => {
    await writePersonality('minimalist', 'name: Minimalist\nskin: mono\n');
    const reg = new FilePersonalityRegistry();
    await reg.loadFromDirectory(testDir);
    expect(reg.get('minimalist')?.skin).toBe('mono');
  });

  it('leaves skin undefined when config omits the field', async () => {
    await writePersonality('plain', 'name: Plain\n');
    const reg = new FilePersonalityRegistry();
    await reg.loadFromDirectory(testDir);
    expect(reg.get('plain')?.skin).toBeUndefined();
  });

  it('accepts a custom skin name (validator runs at skin load time, not here)', async () => {
    await writePersonality('experimental', 'name: Experimental\nskin: my-custom-skin\n');
    const reg = new FilePersonalityRegistry();
    await reg.loadFromDirectory(testDir);
    // Loader is permissive — unknown skin names propagate; surfaces fall
    // back at render time. This is intentional so a stale skin name
    // doesn't break the entire personality load.
    expect(reg.get('experimental')?.skin).toBe('my-custom-skin');
  });
});
