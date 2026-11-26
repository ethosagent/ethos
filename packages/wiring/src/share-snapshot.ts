// Frozen, redacted, read-only copy of one session for a share link
// (plan/phases/share-links.md §3, D2, D5, D6, D8).
//
// Guarantees, each pinned by packages/wiring/src/__tests__/share-snapshot.test.ts:
// - only `user`, `user_steer` (as `user`) and `assistant` rows survive; system,
//   tool_result and unknown roles are dropped, and tool inputs/outputs are never copied;
// - `tools` (name + error flag) appear on assistant turns only with `includeToolNames`;
// - user rows keep only the typed text: attachment annotations, inline uploaded-file
//   text and attachment error lines are stripped (`userPromptBody`, packages/types/src/prompt-annotations.ts);
// - the `[interrupted — <provider error>]` trailer on assistant rows is stripped
//   (INTERRUPTED_TRAILER, written by stream-step.ts);
// - every text, title and tool name passes `redactString`, then `redactPii` unless
//   `pii === false`;
// - pure: same input gives deep-equal output, `createdAt` is supplied by the caller.

import { redactPii, redactString } from '@ethosagent/safety-redact';
import { COMPACTION_ROW_TOOL_NAME, userPromptBody } from '@ethosagent/types';

export interface ShareSnapshotTool {
  name: string;
  isError: boolean;
}

export interface ShareSnapshotTurn {
  role: 'user' | 'assistant';
  text: string;
  tools?: ShareSnapshotTool[];
}

export interface ShareSnapshot {
  v: 1;
  title: string;
  personalityId: string | null;
  createdAt: string;
  turns: ShareSnapshotTurn[];
}

export interface ShareSnapshotOptions {
  /** Include tool names and a success/failure flag on assistant turns (D6). */
  includeToolNames: boolean;
  /** Redact PII (email, phone, card, SSN, IBAN). Default true; `false` keeps it. */
  pii?: boolean;
  /** ISO timestamp stamped on the snapshot; supplied by the caller, never read from a clock. */
  createdAt: string;
}

/** The session fields a snapshot reads. */
export interface ShareSnapshotSession {
  title?: string | null;
  personalityId?: string | null;
}

/**
 * The stored-message fields a snapshot reads. Structurally satisfied by the
 * core `StoredMessage`; `role` is a plain string so unknown roles are dropped,
 * not rejected.
 */
export interface ShareSnapshotMessage {
  role: string;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ReadonlyArray<{ id: string; name: string; input?: unknown }>;
  isError?: boolean;
}

const UNTITLED = 'Untitled session';

// Marker appended to a partial assistant reply by stream-step.ts (`persistInterruptedAssistant`);
// its label is a provider error message, not assistant text.
const INTERRUPTED_TRAILER = /\n\n\[interrupted — [\s\S]*\]$/;

/** UTF-8 byte length of the JSON the store will persist. */
export function shareSnapshotBytes(snapshot: ShareSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}

export function buildShareSnapshot(
  session: ShareSnapshotSession,
  messages: ReadonlyArray<ShareSnapshotMessage>,
  options: ShareSnapshotOptions,
): ShareSnapshot {
  const scrub = (value: string): string => {
    const secretFree = redactString(value);
    return options.pii === false ? secretFree : redactPii(secretFree);
  };

  // tool_result rows follow their assistant row; `isError` is only ever
  // recorded there. `true` is a recorded failure; absent or false is reported
  // as not failed.
  const failed = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool_result' && m.toolCallId !== undefined && m.isError === true) {
      failed.add(m.toolCallId);
    }
  }

  const turns: ShareSnapshotTurn[] = [];
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'user_steer') {
      const text = scrub(userPromptBody(m.content));
      if (text.trim() === '') continue;
      turns.push({ role: 'user', text });
    } else if (m.role === 'assistant') {
      if (m.toolName === COMPACTION_ROW_TOOL_NAME) continue;
      const text = scrub(m.content.replace(INTERRUPTED_TRAILER, ''));
      const tools =
        options.includeToolNames && m.toolCalls && m.toolCalls.length > 0
          ? m.toolCalls.map((tc) => ({ name: scrub(tc.name), isError: failed.has(tc.id) }))
          : undefined;
      if (text.trim() === '' && tools === undefined) continue;
      turns.push(tools ? { role: 'assistant', text, tools } : { role: 'assistant', text });
    }
  }

  const title = session.title ? scrub(session.title) : UNTITLED;
  return {
    v: 1,
    title: title.trim() === '' ? UNTITLED : title,
    personalityId: session.personalityId ?? null,
    createdAt: options.createdAt,
    turns,
  };
}
