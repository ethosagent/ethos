import { ContentRenderer, type FenceRendererResolver } from '@ethosagent/ui-components';
import { useQuery } from '@tanstack/react-query';
import { memo } from 'react';
import { CardView } from '../../features/cards/CardView';
import { formatBytes, type MessageAttachment } from '../../lib/attachments';
import type {
  AssistantBlock,
  AssistantTurn,
  TurnRunMeta,
  UserMessage,
} from '../../lib/chat-reducer';
import type { TrailEntry } from '../../lib/trail';
import { rpc } from '../../rpc';
import { HtmlBlock } from './HtmlBlock';
import { ImageBlock } from './ImageBlock';
import { PdfBlock } from './PdfBlock';
import { PlayButton } from './PlayButton';
import { RunAnchor, type RunSurface } from './RunCard';
import { Trail } from './Trail';

// One rendered message. DESIGN.md voice rules in effect:
//   • User messages: bg-overlay tint, sm radius, right-anchored.
//   • Assistant turns: bare content, left-anchored. The Linear-density
//     pattern, not the iMessage pattern.
//
// The answer is content only (feedback & activity contract §1): the bubble
// holds text, images, HTML, PDF, cards and the delegated-run card — never a
// tool chip, badge or status. What the agent DID goes above the bubble, in the
// collapsed `Trail` line, so the actions read before the answer.

// Both bubbles are memoized: with a long history loaded, a streamed token must
// re-render only the live bubble. That holds only while the props they are
// given stay referentially stable — see MessageList's `AssistantHistoryRow`.
export const UserBubble = memo(function UserBubble({
  message,
  onRetry,
  onDiscard,
}: {
  message: UserMessage;
  /** W1 — re-send this failed message verbatim. Stable, keyed by id here. */
  onRetry?: (messageId: string) => void;
  /** W1 — drop the failed bubble; the hook restores the draft. */
  onDiscard?: (messageId: string) => void;
}) {
  const attachments = message.attachments ?? [];
  return (
    <div className="message-row message-row-user">
      {message.isSteer && <div className="message-steer-label">↗ Steering</div>}
      {/* The turn arrived as speech. The marker sits ABOVE the transcript, in
          the same 11px mono treatment as the steering marker, so the
          transcript is fully readable beside it and never replaces the fact
          that it was spoken. */}
      {message.origin === 'voice' && (
        <div className="message-voice-label" role="note" aria-label="Sent by voice">
          voice
        </div>
      )}
      {message.content ? <div className="message-user">{message.content}</div> : null}
      {attachments.length > 0 ? (
        <div className="message-attachments">
          {attachments.map((a) => (
            <AttachmentChip key={a.localId} attachment={a} />
          ))}
        </div>
      ) : null}
      {/* W1 — a send the server refused. The bubble stays (DESIGN.md item 7);
          this row says so and carries the two verbs. Glyph + word, never
          colour alone. */}
      {message.status === 'failed' ? (
        <div className="message-send-failed" role="alert">
          <span className="message-send-failed-state">⚠ not sent</span>
          {message.error ? (
            <span className="message-send-failed-reason" title={message.error}>
              {message.error}
            </span>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              className="message-send-failed-btn"
              onClick={() => onRetry(message.id)}
            >
              Retry
            </button>
          ) : null}
          {onDiscard ? (
            <button
              type="button"
              className="message-send-failed-btn"
              onClick={() => onDiscard(message.id)}
            >
              Discard
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function AttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  const { state, type, name, sizeBytes, previewUrl } = attachment;
  return (
    <div className={`message-attachment-chip ${state}`}>
      {type === 'image' && previewUrl ? (
        <img src={previewUrl} alt={name} className="message-attachment-thumb" />
      ) : (
        <div className="message-attachment-meta">
          <span className="message-attachment-name">{name}</span>
          <span className="message-attachment-size">{formatBytes(sizeBytes)}</span>
        </div>
      )}
      {state === 'uploading' ? (
        <span className="message-attachment-spinner" role="img" aria-label="Uploading" />
      ) : null}
      {state === 'error' ? (
        <span className="message-attachment-error" title="Upload failed">
          ! failed
        </span>
      ) : null}
    </div>
  );
}

export const AssistantBubble = memo(function AssistantBubble({
  turn,
  streaming,
  fenceRenderers,
  onSuggestPrompt,
  personalityId,
  runSurface,
  trail,
  stopped,
  runMeta,
}: {
  turn: AssistantTurn;
  streaming?: boolean;
  /** Fence-upgrade decision for this surface. Must be referentially stable. */
  fenceRenderers?: FenceRendererResolver;
  /** Puts a `recommend_actions` prompt in the composer. */
  onSuggestPrompt?: (prompt: string) => void;
  /** Who is speaking — carried to the Play button so click-to-hear uses this
   *  personality's voice rather than the deployment default. */
  personalityId?: string;
  /** Live state for the delegated-run cards this turn anchors (§4.1). */
  runSurface?: RunSurface;
  /** This turn's activity trail — the line above the bubble. */
  trail?: TrailEntry[];
  /** The user stopped this turn. */
  stopped?: boolean;
  /** A4 — what the turn ran on; the trail footer names it. */
  runMeta?: TurnRunMeta;
}) {
  const fullText = turn.blocks
    .filter((b): b is Extract<AssistantBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.content)
    .join('\n');
  const { data: caps } = useQuery({
    queryKey: ['meta', 'capabilities'],
    queryFn: () => rpc.meta.capabilities(),
    staleTime: 60_000,
  });
  const ttsEnabled = caps?.capabilities.voice_tts ?? false;
  return (
    <div className="message-row message-row-assistant">
      <Trail
        entries={trail ?? []}
        turnId={turn.id}
        {...(stopped ? { stopped } : {})}
        {...(runMeta ? { meta: runMeta } : {})}
      />
      <div className="message-assistant">
        {turn.blocks.map((block, idx) => (
          <BlockRenderer
            key={blockKey(block, idx)}
            block={block}
            streamingTail={streaming && idx === turn.blocks.length - 1}
            fenceRenderers={fenceRenderers}
            onSuggestPrompt={onSuggestPrompt}
            {...(runSurface ? { runSurface } : {})}
          />
        ))}
        {!streaming && fullText && ttsEnabled ? (
          <PlayButton text={fullText} {...(personalityId ? { personalityId } : {})} />
        ) : null}
      </div>
    </div>
  );
});

function BlockRenderer({
  block,
  streamingTail,
  fenceRenderers,
  onSuggestPrompt,
  runSurface,
}: {
  block: AssistantBlock;
  streamingTail?: boolean;
  fenceRenderers?: FenceRendererResolver;
  onSuggestPrompt?: (prompt: string) => void;
  runSurface?: RunSurface;
}) {
  if (block.kind === 'text') {
    return (
      <>
        <ContentRenderer
          content={block.content}
          format="markdown"
          fenceRenderers={fenceRenderers}
          // Only the tail block of a live turn can hold an unclosed fence;
          // earlier blocks in the same turn are already complete.
          streaming={streamingTail}
        />
        {streamingTail ? <span className="streaming-cursor" aria-hidden="true" /> : null}
      </>
    );
  }
  if (block.kind === 'image') {
    return <ImageBlock block={block} />;
  }
  if (block.kind === 'html') {
    return <HtmlBlock block={block} />;
  }
  if (block.kind === 'pdf') {
    return <PdfBlock block={block} />;
  }
  if (block.kind === 'card') {
    return <CardView card={block.card} onSuggestPrompt={onSuggestPrompt} />;
  }
  if (block.kind === 'run') {
    // The anchor records where the handoff happened; the card is drawn from
    // live digest state, which only the chat page holds. No surface (history
    // replay, the Call Stage) renders nothing rather than a frozen card.
    if (!runSurface) return null;
    return <RunAnchor jobId={block.jobId} surface={runSurface} />;
  }
  return null;
}

function blockKey(block: AssistantBlock, idx: number): string {
  if (block.kind === 'text') return `text-${idx}`;
  if (block.kind === 'image') return `image-${block.toolCallId}`;
  if (block.kind === 'html') return `html-${block.toolCallId}`;
  if (block.kind === 'pdf') return `pdf-${block.toolCallId}`;
  // One tool call can emit several cards, so the id alone is not unique.
  if (block.kind === 'card') return `card-${block.toolCallId}-${idx}`;
  return `run-${block.jobId}`;
}
