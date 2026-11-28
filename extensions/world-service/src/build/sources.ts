// First-build sources (plan world-model Task 5.1, review focus R10).
//
// Three sources only: the personality's OWN MEMORY.md and USER.md, its OWN
// sessions whose conversation was the owner's, and files under folders the
// user named, read through the turn's own fs reach. Everything arrives through
// injected functions, so this module holds no storage, no session store and no
// path of its own.
//
// What pins each guarantee (extensions/world-service/src/__tests__/build-sources.test.ts):
//   - shared, non-owner-DM and incognito sessions are skipped through the
//     injected `isShared` (wiring binds `turnWasShared`): 'R10 first build
//     skips shared and incognito sessions'.
//   - a session of another personality is dropped here even if the injected
//     lister returns it, and `memory` is asked for this personality only:
//     'another personality's sessions are never listed'.
//   - a folder the fs reach refuses becomes a `refused` chunk, never an empty
//     success: 'a folder outside fs reach is refused'.
//   - only sessions updated after the watermark are read:
//     'watermark: only sessions after the last build are read'.

import type { Session, StoredMessage } from '@ethosagent/types';

export interface BuildSourceDeps {
  /** MEMORY.md and USER.md of one personality, via the memory bundle (the single owner). */
  memory: (pid: string) => Promise<{ memory: string; user: string }>;
  sessions: (
    pid: string,
    since: string | null,
  ) => AsyncIterable<{ session: Session; messages: StoredMessage[] }>;
  /** `turnWasShared`, bound in wiring. */
  isShared: (s: Session) => boolean;
  /** The turn's own fs reach: throws `PATH_NOT_REACHABLE:` for a path outside it. */
  readFolder: (path: string) => AsyncIterable<{ path: string; text: string }>;
}

/** What the last build had already read. Sessions updated at or before `sessionsSince` are skipped. */
export interface BuildWatermark {
  sessionsSince: string | null;
}

export type BuildChunkKind = 'memory' | 'session' | 'file';

export interface BuildChunk {
  kind: BuildChunkKind;
  /** `memory:MEMORY.md`, `session:<id>`, `file:<path>`; carried onto every fact extracted from it. */
  sourceRef: string;
  text: string;
  /** Set on a chunk that could not be read; `text` is empty. */
  refused?: string;
  /** Session chunks: the session's `updatedAt`, so the next watermark can advance. */
  at?: string;
}

export interface BuildInput {
  personalityId: string;
  folders: string[];
  watermark: BuildWatermark | null;
}

/** Characters of conversation per chunk (one auxiliary call each). */
export const CHUNK_CHARS = 6000;

const REACH_PREFIX = 'PATH_NOT_REACHABLE:';

const isReach = (e: unknown): e is Error =>
  e instanceof Error && e.message.startsWith(REACH_PREFIX);

function split(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) out.push(text.slice(i, i + CHUNK_CHARS));
  return out;
}

export async function* collectBuildInputs(
  deps: BuildSourceDeps,
  input: BuildInput,
): AsyncGenerator<BuildChunk> {
  const { personalityId: pid } = input;
  const since = input.watermark?.sessionsSince ?? null;

  const mem = await deps.memory(pid);
  for (const [name, text] of [
    ['MEMORY.md', mem.memory],
    ['USER.md', mem.user],
  ] as const) {
    if (text.trim() === '') continue;
    for (const part of split(text)) {
      yield { kind: 'memory', sourceRef: `memory:${name}`, text: part };
    }
  }

  for await (const { session, messages } of deps.sessions(pid, since)) {
    if (session.personalityId !== pid) continue;
    if (deps.isShared(session)) continue;
    const at = session.updatedAt.toISOString();
    if (since !== null && at <= since) continue;
    const convo = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');
    if (convo.trim() === '') continue;
    for (const part of split(convo)) {
      yield { kind: 'session', sourceRef: `session:${session.id}`, text: part, at };
    }
  }

  for (const folder of input.folders) {
    try {
      for await (const f of deps.readFolder(folder)) {
        if (f.text.trim() === '') continue;
        for (const part of split(f.text)) {
          yield { kind: 'file', sourceRef: `file:${f.path}`, text: part };
        }
      }
    } catch (e) {
      if (!isReach(e)) throw e;
      yield {
        kind: 'file',
        sourceRef: `file:${folder}`,
        text: '',
        refused: `"${folder}" is outside this personality's fs_reach allowlist`,
      };
    }
  }
}
