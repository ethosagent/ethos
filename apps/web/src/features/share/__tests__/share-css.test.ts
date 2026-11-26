// Share stylesheet conventions (review F4, F10): motion comes from the shared
// tokens in styles.css, the global reduced-motion handling (main.tsx) is not
// repeated here, and the settings-only `.api-key-revoked` rule lives with the
// settings styles. Source-text assertions, like design-tokens.test.ts.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const share = readFileSync(join(src, 'features/share/share.css'), 'utf8');
const settingsUx = readFileSync(join(src, 'pages/settings/settings-ux.css'), 'utf8');

describe('share.css', () => {
  it('takes motion from --motion-fast / --ease, defining neither them nor its own', () => {
    expect(share).toMatch(/transition:[^;]*var\(--motion-fast, 80ms\) var\(--ease, /);
    expect(share).not.toMatch(/--motion-default\s*:/);
    expect(share).not.toContain('--share-ease');
    expect(share).not.toMatch(/--motion-fast\s*:/);
  });

  it('has no local reduced-motion block (main.tsx owns it globally)', () => {
    expect(share).not.toContain('prefers-reduced-motion');
  });

  it('does not own the settings pane API-key rule', () => {
    expect(share).not.toContain('.api-key-revoked');
    expect(settingsUx).toMatch(/\.api-key-revoked\s*{\s*opacity: 0\.5;/);
  });
});
