import { slashCommandsForSurface } from '@ethosagent/surface-kit';
import { describe, expect, it } from 'vitest';
import { PLATFORM_COMMANDS } from '../index';

// The gateway's executor table (`PLATFORM_COMMANDS`) and the shared registry's
// `gateway` surface (`SLASH_COMMANDS` in @ethosagent/surface-kit) must name the
// same commands: a command advertised to channels with no executor falls
// through to the model as a chat message, and an executor the registry does not
// advertise is missing from every command list built from it. Registering a
// gateway command is therefore the registry entry plus the executor key, and
// this test fails if either is missing.
describe('gateway slash registry drift', () => {
  it('every gateway-surface command has an executor, and every executor is advertised', () => {
    const advertised = slashCommandsForSurface('gateway')
      .map((c) => `/${c.name}`)
      .sort();
    const executed = Object.keys(PLATFORM_COMMANDS).sort();
    expect(executed).toEqual(advertised);
  });

  it('/budget is a gateway command (S4/U1)', () => {
    expect(PLATFORM_COMMANDS['/budget']).toBe('budget');
  });
});
