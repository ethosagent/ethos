// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime.
//
// Containment 3a, OS layer: the personality's own definition is mounted
// read-only in the container, with the asset folder `ownDir/files` rw beneath
// it. This is the half of `writeDeny` a terminal inside the sandbox cannot
// route around — `echo x >> toolset.yaml` gets "Read-only file system".

import type {
  ExecutionBackendConfig,
  Logger,
  PersonalityConfig,
  SecretsResolver,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DockerExecutionBackend } from '../index';

const ETHOS_HOME = '/home/tester/.ethos';
const CWD = '/work/project';
const OWN = `${ETHOS_HOME}/personalities/bob`;

const secrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

function modes(reach?: PersonalityConfig['fs_reach']): Map<string, 'ro' | 'rw'> {
  const config: ExecutionBackendConfig = {
    images: { default: 'x@sha256:abc' },
    substitutionVars: { ethosHome: ETHOS_HOME, cwd: CWD },
  };
  const be = new DockerExecutionBackend({ config, secrets, logger }, async () => false);
  const p = { id: 'bob', name: 'bob', fs_reach: reach } as unknown as PersonalityConfig;
  return new Map(be.mountsFor(p).map((m) => [m.hostPath, m.mode]));
}

describe('mountsFor — the personality definition is read-only', () => {
  it('default personality: ownDir is ro, ownDir/files is rw, cwd stays rw', () => {
    const m = modes(undefined);
    expect(m.get(OWN)).toBe('ro');
    expect(m.get(`${OWN}/files`)).toBe('rw');
    expect(m.get(CWD)).toBe('rw');
  });

  it("declared write: ['${ETHOS_HOME}/'] keeps ETHOS_HOME rw but still gains a ro ownDir child", () => {
    const m = modes({ write: ['${ETHOS_HOME}/'] });
    expect(m.get(ETHOS_HOME)).toBe('rw');
    expect(m.get(OWN)).toBe('ro');
    expect(m.get(`${OWN}/files`)).toBe('rw');
  });

  it('a declared rw mount at a definition entry is downgraded to ro', () => {
    const m = modes({ write: ['${ETHOS_HOME}/personalities/${self}/skills/', '/data/out'] });
    expect(m.get(`${OWN}/skills`)).toBe('ro');
    expect(m.get('/data/out')).toBe('rw');
  });

  it('a write reach that does not cover ownDir adds no definition mounts', () => {
    const m = modes({ read: ['/data/in'], write: ['/data/out'] });
    expect(m.has(OWN)).toBe(false);
    expect(m.has(`${OWN}/files`)).toBe(false);
  });
});
