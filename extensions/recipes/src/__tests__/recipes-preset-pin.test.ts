import { getPreset } from '@ethosagent/tools-mcp/presets';
import { describe, expect, it } from 'vitest';
import { morningBriefing } from '../data';

// morning-briefing used to keep its own unpinned copy of the Google Calendar
// argv. It now reads the preset; this pins that no literal creeps back.
describe('morning-briefing google-calendar server', () => {
  it("is the preset's pinned argv", () => {
    const preset = getPreset('google-calendar');
    const server = morningBriefing.requires.mcpServers.find((s) => s.name === 'google-calendar');
    expect(preset).toBeDefined();
    expect(server?.command).toBe(preset?.command);
    expect(server?.args).toEqual(preset?.args);
    expect(server?.args?.some((a) => /@\d+\.\d+\.\d+/.test(a))).toBe(true);
  });
});
