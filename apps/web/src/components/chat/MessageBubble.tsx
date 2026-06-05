import { ContentRenderer } from '@ethosagent/ui-components';
import type { AssistantBlock, AssistantTurn, UserMessage } from '../../lib/chat-reducer';
import { ToolChip } from './ToolChip';

// One rendered message. DESIGN.md voice rules in effect:
//   • User messages: bg-overlay tint, sm radius, right-anchored.
//   • Assistant turns: bare text + inline tool chips, left-anchored.
//     The Linear-density pattern, not the iMessage pattern.

export function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="message-row message-row-user">
      {message.isSteer && <div className="message-steer-label">↗ Steering</div>}
      <div className="message-user">{message.content}</div>
    </div>
  );
}

export function AssistantBubble({ turn, streaming }: { turn: AssistantTurn; streaming?: boolean }) {
  const lastBlock = turn.blocks[turn.blocks.length - 1];
  const cursorAfter = streaming && lastBlock?.kind === 'text';
  return (
    <div className="message-row message-row-assistant">
      <div className="message-assistant">
        {turn.blocks.map((block, idx) => (
          <BlockRenderer
            key={blockKey(block, idx)}
            block={block}
            streamingTail={streaming && idx === turn.blocks.length - 1}
          />
        ))}
        {/* If the live turn ended on a tool block (no trailing text yet),
            the streaming cursor sits as a standalone marker so the user
            can see the agent is still active even before the next chunk
            of text arrives. */}
        {streaming && !cursorAfter && lastBlock?.kind === 'tool' ? (
          <span className="streaming-cursor streaming-cursor-trailing" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  );
}

function BlockRenderer({
  block,
  streamingTail,
}: {
  block: AssistantBlock;
  streamingTail?: boolean;
}) {
  if (block.kind === 'text') {
    return (
      <>
        <ContentRenderer content={block.content} format="markdown" />
        {streamingTail ? <span className="streaming-cursor" aria-hidden="true" /> : null}
      </>
    );
  }
  return <ToolChip tool={block} />;
}

function blockKey(block: AssistantBlock, idx: number): string {
  return block.kind === 'tool' ? `tool-${block.toolCallId}` : `text-${idx}`;
}
