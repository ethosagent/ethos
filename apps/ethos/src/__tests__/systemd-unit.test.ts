import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('systemd unit templates', () => {
  const templateDir = join(import.meta.dirname, '..', '..', 'templates', 'systemd');

  for (const name of ['ethos-gateway', 'ethos-serve', 'ethos-runall']) {
    it(`${name} template has valid systemd structure`, () => {
      const file = name === 'ethos-runall' ? `${name}.service.tmpl` : `${name}.service.tmpl`;
      const content = readFileSync(join(templateDir, file), 'utf-8');
      expect(content).toContain('[Unit]');
      expect(content).toContain('[Service]');
      expect(content).toContain('[Install]');
      expect(content).toContain('{{ETHOS_BINARY}}');
      expect(content).toContain('{{ETHOS_USER}}');
      expect(content).toContain('{{ETHOS_HOME}}');
      expect(content).toContain('ETHOS_MANAGED=1');
    });
  }
});
