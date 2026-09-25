import { type EthosConfig, parseConfigYaml } from '@ethosagent/config';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { checkDockerSandbox, dockerSandboxLines } from '../commands/doctor';

// `ethos doctor` names every personality whose exec tools will refuse because
// the docker posture has no `execution.docker.image` — the swing-trader goal
// run found out one `terminal` call at a time.

const BASE = ['provider: anthropic', 'model: claude-opus-4-7', 'personality: trader'];
const cfg = (...lines: string[]): EthosConfig => parseConfigYaml([...BASE, ...lines].join('\n'));
const NOT_CONTAINERIZED = { env: {}, fileExists: () => false, readFile: () => null };
const IMAGE = `node@sha256:${'f'.repeat(64)}`;

const PEOPLE = [
  { id: 'trader', name: 'Trader', toolset: ['terminal', 'read_file'] },
  { id: 'chatty', name: 'Chatty', toolset: ['read_file'] },
  { id: 'coder', name: 'Coder', toolset: ['run_code'] },
] as PersonalityConfig[];

function plain(lines: string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes.
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

describe('ethos doctor — docker sandbox image', () => {
  it('flags docker-posture personalities when no image is configured', async () => {
    const report = await checkDockerSandbox(
      cfg('execution.docker.cpu: 2'),
      PEOPLE,
      NOT_CONTAINERIZED,
    );
    expect(report.image).toBeUndefined();
    expect(report.dockerPersonalities).toEqual(['coder', 'trader']);
    expect(report.missingMessage).toMatch(/^Docker sandbox has no image configured/);
    const text = plain(dockerSandboxLines(report));
    expect(text).toContain(
      'docker posture, no image configured → exec tools will fail for: coder, trader',
    );
    expect(text).toContain('execution.docker.image: <image>@sha256:<digest>');
  });

  it('prints the image when one is configured', async () => {
    const report = await checkDockerSandbox(
      cfg(`execution.docker.image: ${IMAGE}`),
      PEOPLE,
      NOT_CONTAINERIZED,
    );
    expect(report).toEqual({ image: IMAGE, dockerPersonalities: ['coder', 'trader'] });
    expect(plain(dockerSandboxLines(report))).toBe(`     docker:      ${IMAGE} (coder, trader)`);
  });

  it('says nothing when no personality runs in docker', async () => {
    const report = await checkDockerSandbox(
      cfg(),
      [PEOPLE[1]] as PersonalityConfig[],
      NOT_CONTAINERIZED,
    );
    expect(report.dockerPersonalities).toEqual([]);
    expect(dockerSandboxLines(report)).toEqual([]);
  });

  it('treats an unpinned image as missing (the config owner dropped it)', async () => {
    const report = await checkDockerSandbox(
      cfg('execution.docker.image: node:24-bookworm'),
      PEOPLE,
      NOT_CONTAINERIZED,
    );
    expect(report.image).toBeUndefined();
    expect(report.missingMessage).toBeDefined();
  });
});
