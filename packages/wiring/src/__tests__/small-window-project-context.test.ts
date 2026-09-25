// Small-window mode counts the project-context injection.
//
// `resolveSmallWindowMode` decided from SOUL, the prelude and the tool schemas,
// but not the AGENTS.md/CLAUDE.md "Project Context" block. In the ollama repro
// a prefix at ~95% of a 32k window did not enter small-window mode because the
// ~78k-char AGENTS.md was not counted. Pins `projectContextAtStartup`
// (project-context-floor.ts), the `projectContextChars` term of
// `measureStaticFloor` and `smallWindowModeMessage` (static-floor.ts), and the
// build-agent-loop wiring that joins them.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import { FileContextInjector } from '@ethosagent/skills';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  PersonalityConfig,
} from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { createAgentLoop, type WiringConfig } from '../index';
import { resolveSmallWindowMode } from '../model-catalog';
import { projectContextAtStartup } from '../project-context-floor';
import {
  measureStaticFloor,
  PROJECT_CONTEXT_COMPONENT,
  smallWindowModeMessage,
} from '../static-floor';

const WINDOW = 32_768;
// A modest SOUL + prelude + tool payload: ~20% of a 32k window on its own.
const BASE = { soulChars: 4_000, toolSchemaChars: 17_000, toolCount: 20, preludeChars: 3_000 };

let root: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-small-window-project-context-'));
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function project(name: string, agentsMdChars: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (agentsMdChars > 0) {
    writeFileSync(join(dir, 'AGENTS.md'), `# Project\n\n${'rule. '.repeat(agentsMdChars / 6)}`);
  }
  return dir;
}

describe('measureStaticFloor — the project-context term', () => {
  it('a large project context pushes the prefix over the small-window threshold', () => {
    const without = measureStaticFloor(BASE);
    const withContext = measureStaticFloor({ ...BASE, projectContextChars: 92_000 });
    expect(resolveSmallWindowMode({ contextWindow: WINDOW, staticTokens: without.tokens })).toBe(
      false,
    );
    expect(
      resolveSmallWindowMode({ contextWindow: WINDOW, staticTokens: withContext.tokens }),
    ).toBe(true);
    expect(withContext.tokens).toBe(Math.ceil((24_000 + 92_000) / 4));
    expect(withContext.components.at(-1)).toEqual({
      name: PROJECT_CONTEXT_COMPONENT,
      chars: 92_000,
      tokens: 23_000,
    });
  });

  it('no project context → the floor is unchanged, component list included', () => {
    expect(measureStaticFloor({ ...BASE, projectContextChars: 0 })).toEqual(
      measureStaticFloor(BASE),
    );
  });

  it('the startup notice names the trigger and the project context as the largest part', () => {
    const floor = measureStaticFloor({ ...BASE, projectContextChars: 92_000 });
    const msg = smallWindowModeMessage({
      personalityId: 'researcher',
      windowTokens: WINDOW,
      floor,
    });
    expect(msg).toContain('small-window mode on for personality `researcher`');
    expect(msg).toContain('static prefix above 40% of the window');
    expect(msg).toContain('89% of the 32,768-token window');
    expect(msg).toContain(`Largest: ${PROJECT_CONTEXT_COMPONENT} (~23,000 tokens)`);
  });
});

describe('projectContextAtStartup — the same content the prompt sends', () => {
  it('returns exactly the block the loop puts in the system prompt for that directory', async () => {
    const dir = project('same-content', 6_000);
    const storage = new FsStorage();
    const injector = new FileContextInjector({ storage });
    const personality = { id: 'p', name: 'p' } as PersonalityConfig;
    const measured = await projectContextAtStartup({
      injectors: [injector],
      personality,
      workingDir: dir,
      dataDir: join(root, 'state'),
      platform: 'cli',
      model: 'm',
    });
    expect(measured.startsWith('## Project Context')).toBe(true);
    expect(measured.length).toBeGreaterThan(6_000);

    let system = '';
    const llm: LLMProvider = {
      name: 'mock',
      model: 'm',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(_m, _t, opts?: CompletionOptions) {
        system = opts?.system ?? '';
        const chunks: CompletionChunk[] = [
          { type: 'text_delta', text: 'ok' },
          { type: 'done', finishReason: 'end_turn' },
        ];
        for (const c of chunks) yield c;
      },
      async countTokens() {
        return 1;
      },
    };
    const loop = new AgentLoop({
      llm,
      tools: new DefaultToolRegistry(),
      hooks: new DefaultHookRegistry(),
      injectors: [injector],
      options: { workingDir: dir },
      safety: createTestSafety(),
    });
    for await (const _ of loop.run('hi', { sessionKey: 'cli:same' })) {
      // drain
    }
    expect(system).toContain(measured);
  });

  it('is empty when the directory has no discovery file, or no file-context injector is wired', async () => {
    const storage = new FsStorage();
    const base = {
      personality: { id: 'p', name: 'p' } as PersonalityConfig,
      dataDir: join(root, 'state'),
      platform: 'cli',
      model: 'm',
    };
    expect(
      await projectContextAtStartup({
        ...base,
        injectors: [new FileContextInjector({ storage })],
        workingDir: project('bare', 0),
      }),
    ).toBe('');
    expect(
      await projectContextAtStartup({
        ...base,
        injectors: [],
        workingDir: project('no-injector', 6_000),
      }),
    ).toBe('');
  });
});

describe('createAgentLoop — small-window mode and its startup warning', () => {
  async function bootWarnings(workingDir: string): Promise<string[]> {
    const home = join(root, `home-${workingDir.split('/').at(-1)}`);
    const dataDir = join(home, '.ethos');
    mkdirSync(dataDir, { recursive: true });
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
      debug: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: recursive logger mock
      child: () => logger as any,
    };
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      contextWindow: WINDOW,
    };
    const runtime = await createAgentLoop(config, {
      dataDir,
      workingDir,
      profile: 'cli',
      disableDocker: true,
      logger,
    });
    await runtime.dispose();
    return warnings;
  }

  it('a large AGENTS.md in the working directory engages small-window mode, and says so', async () => {
    const warnings = await bootWarnings(project('big-context', 92_000));
    const notice = warnings.find((w) => w.startsWith('small-window mode on'));
    expect(notice).toBeDefined();
    expect(notice).toContain('static prefix above 40% of the window');
    expect(notice).toContain(PROJECT_CONTEXT_COMPONENT);
  });

  it('no project context → small-window mode stays off, no notice', async () => {
    const warnings = await bootWarnings(project('no-context', 0));
    expect(warnings.some((w) => w.startsWith('small-window mode on'))).toBe(false);
  });
});
