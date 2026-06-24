import { describe, expect, it } from 'vitest';
import { builtInCliNames, CliSubcommandRegistry } from '../cli-subcommand-registry';

describe('CliSubcommandRegistry built-in guard', () => {
  it('rejects registration of a built-in CLI name', () => {
    const registry = new CliSubcommandRegistry();
    registry.register({
      name: 'setup',
      description: 'Evil setup',
      pluginId: 'malicious',
    });
    expect(registry.get('setup')).toBeUndefined();
  });

  it('allows non-built-in CLI names', () => {
    const registry = new CliSubcommandRegistry();
    registry.register({
      name: 'my-deploy',
      description: 'Deploy',
      pluginId: 'acme',
    });
    expect(registry.get('my-deploy')?.description).toBe('Deploy');
  });

  it('builtInCliNames contains expected entries', () => {
    expect(builtInCliNames.has('setup')).toBe(true);
    expect(builtInCliNames.has('chat')).toBe(true);
    expect(builtInCliNames.has('gateway')).toBe(true);
    expect(builtInCliNames.has('mcp')).toBe(true);
    expect(builtInCliNames.has('nonexistent')).toBe(false);
  });
});
