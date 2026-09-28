import type {
  LLMProvider,
  Message,
  MessageContent,
  SessionStore,
  SteerAttachmentBlock,
  SteerEntry,
  SteerSink,
} from '@ethosagent/types';

/** Which native blocks the turn's model can read (`ProviderCapabilities`). */
export interface SteerVision {
  images: boolean;
  documents: boolean;
}

/**
 * UBP-012 — which steer attachment blocks a turn's model can read: the same
 * gate context assembly applies to the turn's own attachments
 * (`nativeVision`, stages/context-assembly.ts). An override model's
 * capabilities cannot be verified, so it reads none.
 */
export function steerVisionFor(llm: LLMProvider, modelOverride: string | undefined): SteerVision {
  const caps = modelOverride ? undefined : llm.capabilities;
  return { images: caps?.visionImages === true, documents: caps?.visionDocuments === true };
}

/** The text a steer becomes in front of the model — the one spelling both
 *  drain seams use, so a steer reads the same wherever it lands. */
export function steerText(text: string): string {
  return `[USER STEER]: ${text}`;
}

/**
 * Everything queued in `sink`, blocks included. `drainEntries` when the sink
 * has it (UBP-012); otherwise the text-only `drain`.
 */
export function drainSteerEntries(sink: SteerSink): SteerEntry[] {
  if (sink.drainEntries) return sink.drainEntries();
  return sink.drain().map((text) => ({ text }));
}

/** A block the model cannot read, as a line naming it. */
function degradedLine(block: SteerAttachmentBlock): string {
  const kind = block.type === 'document' ? 'document' : 'image';
  const name = block.filename ? `: ${block.filename}` : '';
  return `[${kind} attached${name} — not sent, this model cannot read ${kind}s]`;
}

/**
 * The blocks one steer entry sends and the blocks it persists. An attachment
 * goes inline only when the turn's model can read that kind — the same gate
 * context assembly applies to a turn's own attachments
 * (`stages/context-assembly.ts`, `nativeVision`); otherwise it becomes a text
 * line naming it, so the model knows something was attached.
 */
export function steerContentBlocks(
  entry: SteerEntry,
  vision: SteerVision | undefined,
): { content: MessageContent[]; persisted: SteerAttachmentBlock[] } {
  const content: MessageContent[] = [];
  const persisted: SteerAttachmentBlock[] = [];
  const degraded: string[] = [];
  for (const block of entry.blocks ?? []) {
    const readable = block.type === 'document' ? vision?.documents : vision?.images;
    if (readable === true) {
      content.push(block);
      persisted.push(block);
    } else {
      degraded.push(degradedLine(block));
    }
  }
  const text = degraded.length > 0 ? `${entry.text}\n${degraded.join('\n')}` : entry.text;
  content.push({ type: 'text', text: steerText(text) });
  return { content, persisted };
}

/** Persist one drained steer as a `user_steer` row (transcript fidelity, and
 *  the text-end replay in `toLLMMessages`, ./history.ts). */
export async function persistSteer(
  session: SessionStore,
  sessionId: string,
  traceId: string | undefined,
  entry: SteerEntry,
  persisted: SteerAttachmentBlock[],
): Promise<void> {
  await session.appendMessage({
    sessionId,
    role: 'user_steer',
    content: entry.text,
    ...(persisted.length > 0 ? { contentBlocks: persisted } : {}),
    traceId,
  });
}

/**
 * UBP-001 / D1 — the text-end seam. The model just answered with text and no
 * tool call; anything the user sent meanwhile was acked as folded into that
 * answer, so it must reach one more LLM call. Drains `sink`, appends the steers
 * to `llmMessages` as one user message, persists each as a `user_steer` row,
 * and reports whether anything was folded — the caller then runs another
 * iteration. The caller owns the assistant message before it: a blank one must
 * be replaced (`EMPTY_ASSISTANT_TEXT`, ./history.ts) since it is no longer
 * final once this user message follows.
 *
 * Pinned by packages/core/src/__tests__/steer-text-end.test.ts.
 */
export async function foldTextEndSteers(
  session: SessionStore,
  sessionId: string,
  traceId: string | undefined,
  sink: SteerSink,
  llmMessages: Message[],
  vision: SteerVision | undefined,
): Promise<boolean> {
  const entries = drainSteerEntries(sink);
  if (entries.length === 0) return false;

  const content: MessageContent[] = [];
  for (const entry of entries) {
    const built = steerContentBlocks(entry, vision);
    content.push(...built.content);
    await persistSteer(session, sessionId, traceId, entry, built.persisted);
  }
  llmMessages.push({ role: 'user', content });
  return true;
}
