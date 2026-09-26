// Item 9 — docker execution-backend resource caps (`execution.docker.cpu` /
// `execution.docker.diskMb`).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  dockerImageRefError,
  ethosDir,
  readRawConfig,
  writeConfig,
} from '../index';

describe('execution.docker config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses cpu and diskMb', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 4', 'execution.docker.diskMb: 20480'].join('\n'),
    );
    expect(cfg?.execution).toEqual({ docker: { cpu: 4, diskMb: 20_480 } });
  });

  it('keeps a fractional cpu but floors diskMb', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 1.5', 'execution.docker.diskMb: 2048.9'].join('\n'),
    );
    expect(cfg?.execution).toEqual({ docker: { cpu: 1.5, diskMb: 2048 } });
  });

  it('drops non-positive and non-numeric values', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 0', 'execution.docker.diskMb: plenty'].join('\n'),
    );
    expect(cfg?.execution).toBeUndefined();
  });

  it('keeps the surviving field when only one is out of range', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: -2', 'execution.docker.diskMb: 512'].join('\n'),
    );
    expect(cfg?.execution).toEqual({ docker: { diskMb: 512 } });
  });

  it('leaves execution undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.execution).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      execution: { docker: { cpu: 3, diskMb: 10_240 } },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.execution).toEqual(original.execution);
  });

  const DIGEST = 'a'.repeat(64);

  it('parses a digest-pinned execution.docker.image', async () => {
    const image = `node@sha256:${DIGEST}`;
    const cfg = await load([...base, `execution.docker.image: ${image}`].join('\n'));
    expect(cfg?.execution).toEqual({ docker: { image } });
    expect(cfg ? configParseNotices(cfg).warnings : []).toEqual([]);
  });

  it('accepts a registry host with a port and a tag before the digest', () => {
    expect(dockerImageRefError(`localhost:5555/ethos/sandbox:1.2@sha256:${DIGEST}`)).toBeNull();
    expect(
      dockerImageRefError(`mirror.gcr.io/library/node:24-bookworm@sha256:${DIGEST}`),
    ).toBeNull();
  });

  it('drops an unpinned image with a warning — never a parse error', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 2', 'execution.docker.image: node:24-bookworm'].join('\n'),
    );
    expect(cfg?.execution).toEqual({ docker: { cpu: 2 } });
    const notices = cfg ? configParseNotices(cfg) : { errors: [], warnings: [] };
    expect(notices.errors).toEqual([]);
    expect(notices.warnings).toEqual([
      expect.stringMatching(
        /^execution\.docker\.image: must be digest-pinned .*'node:24-bookworm'/,
      ),
    ]);
  });

  it('refuses a short digest, whitespace and a leading dash', () => {
    expect(dockerImageRefError('node@sha256:abc')).not.toBeNull();
    expect(dockerImageRefError(`node @sha256:${DIGEST}`)).not.toBeNull();
    expect(dockerImageRefError(`-v/:/host@sha256:${DIGEST}`)).not.toBeNull();
    expect(dockerImageRefError('')).not.toBeNull();
  });

  it('round-trips the image through writeConfig beside the caps', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      execution: {
        docker: { cpu: 2, image: `docker.io/library/node:24-bookworm@sha256:${DIGEST}` },
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain(
      `execution.docker.image: docker.io/library/node:24-bookworm@sha256:${DIGEST}`,
    );
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.execution).toEqual(original.execution);
  });
});
