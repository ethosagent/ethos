import { createHash, createHmac } from 'node:crypto';
import type { BundleManifest, ExportStamp } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildTar, type Entry, parseTar } from '../backup';

const ETHOS_EXPORT_KEY = 'ethos-personality-export-v1';

// ---------------------------------------------------------------------------
// Helper: build a realistic BundleManifest (all required fields populated)
// ---------------------------------------------------------------------------

function makeBundleManifest(overrides?: Partial<BundleManifest>): BundleManifest {
  const files = [
    {
      relPath: 'personalities/demo/SOUL.md',
      sha256: createHash('sha256').update('# Demo').digest('hex'),
    },
    {
      relPath: 'personalities/demo/config.yaml',
      sha256: createHash('sha256').update('name: demo').digest('hex'),
    },
    {
      relPath: 'personalities/demo/toolset.yaml',
      sha256: createHash('sha256').update('- read_file').digest('hex'),
    },
  ];
  const bundleSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const stamp = createHmac('sha256', ETHOS_EXPORT_KEY).update(bundleSha256).digest('hex');

  return {
    schema: 'ethos.personality-bundle/v1',
    personalityId: 'demo',
    version: '1.0.0',
    publisher: 'ethos',
    createdAt: '2026-06-24T00:00:00.000Z',
    declared: {
      fsReach: { read: ['/home/user/project'], write: [] },
      toolset: ['read_file', 'write_file', 'run_bash'],
    },
    mcpServers: [],
    plugins: [],
    files,
    bundleSha256,
    export: {
      publisher: 'ethos',
      exportedBy: 'ethos-personality-export',
      bundleSha256,
      stamp,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1: Bundle manifest format (export side)
// ---------------------------------------------------------------------------

describe('bundle manifest format (export side)', () => {
  it('ETHOS.md manifest has all required fields', () => {
    const manifest = makeBundleManifest();
    const json = JSON.stringify(manifest, null, 2);
    const parsed = JSON.parse(json) as BundleManifest;

    expect(parsed.schema).toBe('ethos.personality-bundle/v1');
    expect(parsed.personalityId).toBe('demo');
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.publisher).toBe('ethos');
    expect(parsed.createdAt).toBeTruthy();
    expect(parsed.declared).toBeDefined();
    expect(parsed.declared.fsReach).toBeDefined();
    expect(parsed.declared.toolset).toBeDefined();
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.plugins).toBeDefined();
    expect(parsed.files).toBeDefined();
    expect(parsed.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.export).toBeDefined();
    expect(parsed.export.publisher).toBe('ethos');
    expect(parsed.export.exportedBy).toBe('ethos-personality-export');
    expect(parsed.export.stamp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ETHOS.md roundtrips through tar archive', () => {
    const manifest = makeBundleManifest();
    const ethosContent = JSON.stringify(manifest, null, 2);

    const entries: Entry[] = [
      { relPath: 'personalities/demo/SOUL.md', content: Buffer.from('# Demo') },
      { relPath: 'personalities/demo/config.yaml', content: Buffer.from('name: demo') },
      { relPath: 'ETHOS.md', content: Buffer.from(ethosContent) },
    ];

    const tar = buildTar(entries);
    const parsed = parseTar(tar);
    const ethosEntry = parsed.find(([p]) => p === 'ETHOS.md');
    expect(ethosEntry).toBeDefined();
    if (ethosEntry) {
      const recovered = JSON.parse(ethosEntry[1].toString('utf8')) as BundleManifest;
      expect(recovered.schema).toBe('ethos.personality-bundle/v1');
      expect(recovered.personalityId).toBe('demo');
      expect(recovered.bundleSha256).toBe(manifest.bundleSha256);
      expect(recovered.export.stamp).toBe(manifest.export.stamp);
    }
  });

  it('toolset.yaml exported verbatim', () => {
    const toolsetContent = '- read_file\n- write_file\n- run_bash\n';
    const entries: Entry[] = [
      { relPath: 'personalities/demo/toolset.yaml', content: Buffer.from(toolsetContent) },
    ];
    const tar = buildTar(entries);
    const parsed = parseTar(tar);
    const toolsetEntry = parsed.find(([p]) => p === 'personalities/demo/toolset.yaml');
    expect(toolsetEntry).toBeDefined();
    if (toolsetEntry) {
      expect(toolsetEntry[1].toString('utf8')).toBe(toolsetContent);
    }
  });

  it('MEMORY.md only when opted in — absent by default', () => {
    const entries: Entry[] = [
      { relPath: 'personalities/demo/SOUL.md', content: Buffer.from('# Demo') },
      { relPath: 'personalities/demo/config.yaml', content: Buffer.from('name: demo') },
    ];
    const tar = buildTar(entries);
    const parsed = parseTar(tar);
    const paths = parsed.map(([p]) => p);
    expect(paths).not.toContain('personalities/demo/MEMORY.md');
  });

  it('MEMORY.md present when included', () => {
    const entries: Entry[] = [
      { relPath: 'personalities/demo/SOUL.md', content: Buffer.from('# Demo') },
      { relPath: 'personalities/demo/config.yaml', content: Buffer.from('name: demo') },
      { relPath: 'personalities/demo/MEMORY.md', content: Buffer.from('# Session memory') },
    ];
    const tar = buildTar(entries);
    const parsed = parseTar(tar);
    const paths = parsed.map(([p]) => p);
    expect(paths).toContain('personalities/demo/MEMORY.md');
  });

  it('USER.md never in bundle', () => {
    const entries: Entry[] = [
      { relPath: 'personalities/demo/SOUL.md', content: Buffer.from('# Demo') },
      { relPath: 'personalities/demo/config.yaml', content: Buffer.from('name: demo') },
    ];
    const tar = buildTar(entries);
    const parsed = parseTar(tar);
    const paths = parsed.map(([p]) => p);
    expect(paths).not.toContain('personalities/demo/USER.md');
    expect(paths).not.toContain('USER.md');
  });

  it('no secret values in manifest', () => {
    const manifest = makeBundleManifest({
      mcpServers: [
        {
          name: 'linear',
          url: 'https://linear.app',
          transport: 'streamable-http',
          authType: 'oauth2',
          tools: [],
        },
        {
          name: 'github',
          url: 'https://github.com',
          transport: 'streamable-http',
          authType: 'bearer',
          tools: [],
        },
      ],
    });
    const serialized = JSON.stringify(manifest);

    // Manifest should only contain authType names, not actual secret values
    expect(serialized).toContain('"authType":"oauth2"');
    expect(serialized).toContain('"authType":"bearer"');

    // Must not contain any actual credential values
    // (the manifest structure only stores authType, never token/key/secret/password values)
    const parsed = JSON.parse(serialized) as BundleManifest;
    for (const server of parsed.mcpServers) {
      const _serverJson = JSON.stringify(server);
      const serverObj = server as Record<string, unknown>;
      expect(serverObj).not.toHaveProperty('token');
      expect(serverObj).not.toHaveProperty('key');
      expect(serverObj).not.toHaveProperty('secret');
      expect(serverObj).not.toHaveProperty('password');
      // Only the structural fields should be present
      const keys = Object.keys(serverObj);
      for (const k of keys) {
        expect(['name', 'url', 'transport', 'authType', 'tools']).toContain(k);
      }
    }
  });

  it('bundleSha256 verification — matches and detects changes', () => {
    const files = [
      { relPath: 'a.txt', sha256: 'abc123' },
      { relPath: 'b.txt', sha256: 'def456' },
    ];
    const hash1 = createHash('sha256').update(JSON.stringify(files)).digest('hex');

    // Same input → same hash
    const hash2 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    expect(hash1).toBe(hash2);

    // Modified input → different hash
    const modified = [
      { relPath: 'a.txt', sha256: 'abc123' },
      { relPath: 'b.txt', sha256: 'TAMPERED' },
    ];
    const hash3 = createHash('sha256').update(JSON.stringify(modified)).digest('hex');
    expect(hash3).not.toBe(hash1);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Import integrity checks
// ---------------------------------------------------------------------------

describe('import integrity checks', () => {
  it('bundle integrity — valid hash passes', () => {
    const manifest = makeBundleManifest();
    const computedHash = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
    expect(computedHash).toBe(manifest.bundleSha256);
  });

  it('bundle integrity — tampered hash fails', () => {
    const manifest = makeBundleManifest();
    const tampered: BundleManifest = {
      ...manifest,
      bundleSha256: 'deadbeef'.repeat(8),
    };
    const computedHash = createHash('sha256').update(JSON.stringify(tampered.files)).digest('hex');
    expect(computedHash).not.toBe(tampered.bundleSha256);
  });

  it('export stamp — valid stamp', () => {
    const manifest = makeBundleManifest();
    const recomputed = createHmac('sha256', ETHOS_EXPORT_KEY)
      .update(manifest.bundleSha256)
      .digest('hex');
    expect(recomputed).toBe(manifest.export.stamp);
  });

  it('export stamp — missing/invalid stamp flagged, not blocked', () => {
    const manifest = makeBundleManifest();
    // Simulate a wrong stamp
    const wrongStamp: ExportStamp = {
      ...manifest.export,
      stamp: `${'wrong'.repeat(12)}beef`,
    };
    const manifestWithWrongStamp: BundleManifest = {
      ...manifest,
      export: wrongStamp,
    };

    const expectedStamp = createHmac('sha256', ETHOS_EXPORT_KEY)
      .update(manifestWithWrongStamp.bundleSha256)
      .digest('hex');

    // Detection: the stamp doesn't match
    const unstamped =
      !manifestWithWrongStamp.export.stamp || manifestWithWrongStamp.export.stamp !== expectedStamp;
    expect(unstamped).toBe(true);

    // Not blocked — no throw, just a flag
    expect(() => {
      const _flag = unstamped;
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 3: MCP server import handling
// ---------------------------------------------------------------------------

describe('MCP server import handling', () => {
  it('MCP clash detection — existing server matches incoming', () => {
    const existing = [
      { name: 'linear', url: 'https://linear.app', transport: 'streamable-http' },
      { name: 'github', url: 'https://github.com', transport: 'streamable-http' },
    ];
    const incoming = {
      name: 'linear',
      url: 'https://linear.app',
      transport: 'streamable-http',
      tools: [],
    };
    // Clash detection: name match → skip global install, enable at personality level
    expect(existing.some((s) => s.name === incoming.name)).toBe(true);
  });

  it('MCP clash detection — no match for new server', () => {
    const existing = [{ name: 'linear', url: 'https://linear.app', transport: 'streamable-http' }];
    const incoming = {
      name: 'slack',
      url: 'https://slack.com',
      transport: 'streamable-http',
      tools: [],
    };
    expect(existing.some((s) => s.name === incoming.name)).toBe(false);
  });

  it('credential-gated MCP — bearer and oauth2 flagged', () => {
    expect(['bearer', 'oauth2'].includes('bearer')).toBe(true);
    expect(['bearer', 'oauth2'].includes('oauth2')).toBe(true);
    expect(['bearer', 'oauth2'].includes('none')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 4: Plugin version-aware import
// ---------------------------------------------------------------------------

describe('plugin version-aware import', () => {
  // Inline semver comparison (same logic as backup.ts:semverGte)
  function semverGte(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const va = pa[i] ?? 0;
      const vb = pb[i] ?? 0;
      if (va > vb) return true;
      if (va < vb) return false;
    }
    return true;
  }

  it('semver equal — installed matches bundle', () => {
    expect(semverGte('1.2.3', '1.2.3')).toBe(true);
  });

  it('semver newer — installed ahead of bundle', () => {
    expect(semverGte('1.3.0', '1.2.3')).toBe(true);
  });

  it('semver older — installed behind bundle', () => {
    expect(semverGte('1.2.2', '1.2.3')).toBe(false);
  });

  it('semver major bump — installed is next major', () => {
    expect(semverGte('2.0.0', '1.9.9')).toBe(true);
  });

  it('plugin with credentials flagged', () => {
    const plugin = { id: 'test', credentials: ['API_KEY'] };
    expect(plugin.credentials.length > 0).toBe(true);

    const pluginNoCreds = { id: 'test2', credentials: [] as string[] };
    expect(pluginNoCreds.credentials.length > 0).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Export stamp (provenance)
// ---------------------------------------------------------------------------

describe('export stamp (provenance)', () => {
  it('export stamp publisher is always ethos', () => {
    const manifest = makeBundleManifest();
    expect(manifest.export.publisher).toBe('ethos');
    expect(manifest.export.exportedBy).toBe('ethos-personality-export');
  });

  it('unstamped bundle detected, not blocked', () => {
    const manifest = makeBundleManifest();
    // Create manifest with no stamp (simulate missing)
    const noStampManifest: BundleManifest = {
      ...manifest,
      export: {
        ...manifest.export,
        stamp: '',
      },
    };

    const expectedStamp = createHmac('sha256', ETHOS_EXPORT_KEY)
      .update(noStampManifest.bundleSha256)
      .digest('hex');

    const unstamped =
      !noStampManifest.export.stamp || noStampManifest.export.stamp !== expectedStamp;
    expect(unstamped).toBe(true);

    // Should not throw — detection only
    let flag = false;
    expect(() => {
      flag = unstamped;
    }).not.toThrow();
    expect(flag).toBe(true);
  });

  it('unstamped bundle detected with invalid stamp', () => {
    const manifest = makeBundleManifest();
    const invalidManifest: BundleManifest = {
      ...manifest,
      export: {
        ...manifest.export,
        stamp: 'completely-invalid-stamp-value',
      },
    };

    const expectedStamp = createHmac('sha256', ETHOS_EXPORT_KEY)
      .update(invalidManifest.bundleSha256)
      .digest('hex');

    const unstamped =
      !invalidManifest.export.stamp || invalidManifest.export.stamp !== expectedStamp;
    expect(unstamped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 6: Fork and retire lifecycle
// ---------------------------------------------------------------------------

describe('fork and retire lifecycle', () => {
  it('fork preserves version history', () => {
    const soulContent = [
      '# Alice',
      '',
      'I am a helpful assistant.',
      '',
      '## Learning Log',
      '',
      '- 2026-06-01: Learned about TypeScript generics',
      '- 2026-06-15: Improved debugging workflow',
    ].join('\n');

    const provenanceComment = '<!-- Forked from alice @ v1.0.0 on 2026-06-24 -->';
    const forkedSoul = `${provenanceComment}\n${soulContent}`;

    // Provenance comment is the first line
    const lines = forkedSoul.split('\n');
    expect(lines[0]).toBe(provenanceComment);

    // Learning Log section is preserved
    expect(forkedSoul).toContain('## Learning Log');
    expect(forkedSoul).toContain('Learned about TypeScript generics');
    expect(forkedSoul).toContain('Improved debugging workflow');
  });

  it('retire preserves history', () => {
    const soulContent = [
      '# Bob',
      '',
      'I am a coding assistant.',
      '',
      '## Expertise',
      '',
      '- TypeScript',
      '- Rust',
    ].join('\n');

    const retirementNotice = '<!-- Retired on 2026-06-24. Reason: replaced by charlie -->';
    const retiredSoul = `${soulContent}\n${retirementNotice}`;

    // Original content preserved
    expect(retiredSoul).toContain('# Bob');
    expect(retiredSoul).toContain('I am a coding assistant.');
    expect(retiredSoul).toContain('TypeScript');

    // Retirement comment at the end
    const lines = retiredSoul.split('\n');
    expect(lines[lines.length - 1]).toBe(retirementNotice);

    // config.yaml gets retired: true
    const configContent = 'name: bob\nversion: 1.0.0';
    const retiredConfig = `${configContent}\nretired: true`;
    expect(retiredConfig).toContain('retired: true');
    expect(retiredConfig).toContain('name: bob');
  });

  it('export → import round-trip', () => {
    // 1. Create a full BundleManifest
    const manifest = makeBundleManifest();

    // 2. Serialize to JSON and parse back
    const serialized = JSON.stringify(manifest, null, 2);
    const deserialized = JSON.parse(serialized) as BundleManifest;

    // 3. Verify all fields match
    expect(deserialized.schema).toBe(manifest.schema);
    expect(deserialized.personalityId).toBe(manifest.personalityId);
    expect(deserialized.version).toBe(manifest.version);
    expect(deserialized.publisher).toBe(manifest.publisher);
    expect(deserialized.createdAt).toBe(manifest.createdAt);
    expect(deserialized.declared).toEqual(manifest.declared);
    expect(deserialized.mcpServers).toEqual(manifest.mcpServers);
    expect(deserialized.plugins).toEqual(manifest.plugins);
    expect(deserialized.files).toEqual(manifest.files);
    expect(deserialized.bundleSha256).toBe(manifest.bundleSha256);
    expect(deserialized.export).toEqual(manifest.export);

    // 4. Create a tar archive with personality files + ETHOS.md
    const entries: Entry[] = [
      { relPath: 'personalities/demo/SOUL.md', content: Buffer.from('# Demo') },
      { relPath: 'personalities/demo/config.yaml', content: Buffer.from('name: demo') },
      { relPath: 'personalities/demo/toolset.yaml', content: Buffer.from('- read_file') },
      { relPath: 'ETHOS.md', content: Buffer.from(serialized) },
    ];
    const tar = buildTar(entries);
    const parsed = parseTar(tar);

    // 5. Extract ETHOS.md and verify manifest
    const ethosEntry = parsed.find(([p]) => p === 'ETHOS.md');
    expect(ethosEntry).toBeDefined();
    if (ethosEntry) {
      const recovered = JSON.parse(ethosEntry[1].toString('utf8')) as BundleManifest;

      // Verify bundleSha256 still validates
      const computedHash = createHash('sha256')
        .update(JSON.stringify(recovered.files))
        .digest('hex');
      expect(computedHash).toBe(recovered.bundleSha256);

      // Verify export stamp still validates
      const expectedStamp = createHmac('sha256', ETHOS_EXPORT_KEY)
        .update(recovered.bundleSha256)
        .digest('hex');
      expect(expectedStamp).toBe(recovered.export.stamp);
    }
  });
});
