import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_INVALID_EXIT_CODE, GATEWAY_LOCK_EXIT_CODE } from '@ethosagent/wiring';
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

  // Plan openclaw-2026.9.6-gaps R3: without these a held lock (exit 3) or a
  // bad config (exit 78) restarted every RestartSec forever.
  it('ethos-gateway never restarts a refusal and stops a crash loop', () => {
    const content = readFileSync(join(templateDir, 'ethos-gateway.service.tmpl'), 'utf-8');
    const unit = content.slice(content.indexOf('[Unit]'), content.indexOf('[Service]'));
    const service = content.slice(content.indexOf('[Service]'), content.indexOf('[Install]'));
    expect(service).toContain(
      `RestartPreventExitStatus=${GATEWAY_LOCK_EXIT_CODE} ${CONFIG_INVALID_EXIT_CODE}\n`,
    );
    // Start-rate limits are [Unit] settings on systemd >= 230; in [Service]
    // they are ignored with a warning.
    expect(unit).toContain('StartLimitIntervalSec=300\n');
    expect(unit).toContain('StartLimitBurst=5\n');
    expect(service).not.toContain('StartLimit');
  });
});
