import type { CSSProperties, ReactNode } from 'react';

import styles from './styles.module.css';

// Animated version of the AgentLoop architecture diagram on the landing
// page. Pure CSS keyframes on one shared 14s timeline (no JS timers) —
// same convention as HeroTerminal. The rendered text is glyph-for-glyph
// identical to the previous static <pre>; spans only scope color windows.
// Timeline windows are documented in styles.module.css.
//
// aria-hidden: the surrounding section prose already explains the loop;
// the diagram is a visual restatement.

const BOX_INNER_WIDTH = 54;

const STEPS = [
  '1. resolve or create session',
  '2. fire session_start hooks',
  '3. persist user message',
  '4. load history (trimmed)',
  '5. prefetch memory (per personality scope)',
  '6. build system prompt from injectors',
  '7. before-prompt-build modifying hooks',
  '8. agentic loop (LLM stream → tool calls → LLM ...)',
  '9. pre-flight hooks → execute tools → collect',
];

// Index of "8. agentic loop ..." — the step that re-pulses (it loops).
const LOOP_STEP_INDEX = 7;

function delay(seconds: number): CSSProperties {
  return { animationDelay: `${seconds}s` } as CSSProperties;
}

function StepRow({ text, index }: { text: string; index: number }): ReactNode {
  return (
    <>
      <span className={styles.border}>{'  │'}</span>
      <span
        className={index === LOOP_STEP_INDEX ? styles.stepLoop : styles.step}
        style={delay(index * 0.7)}
      >
        {`  ${text}`.padEnd(BOX_INNER_WIDTH)}
      </span>
      <span className={styles.border}>{'│'}</span>
      {'\n'}
    </>
  );
}

function Event({ name, at }: { name: string; at: number }): ReactNode {
  // `done` has its own keyframe with the window baked in (it settles to
  // success green and holds), so it carries no delay.
  if (name === 'done') {
    return <span className={styles.eventDone}>{name}</span>;
  }
  return (
    <span className={styles.event} style={delay(at)}>
      {name}
    </span>
  );
}

function Surface({ name, at }: { name: string; at: number }): ReactNode {
  return (
    <span className={styles.surface} style={delay(at)}>
      {name}
    </span>
  );
}

export default function ArchDiagramAnimated(): ReactNode {
  return (
    <pre className={styles.diagram} aria-hidden="true">
      <span className={styles.inputText}>{'  user input'}</span>
      {'\n'}
      <span className={styles.connectorIn}>{'       │\n       ▼'}</span>
      {'\n'}
      <span className={styles.border}>{`  ┌${'─'.repeat(BOX_INNER_WIDTH)}┐`}</span>
      {'\n'}
      <span className={styles.border}>{'  │'}</span>
      <span className={styles.title}>
        {'  AgentLoop.run(input, options)'.padEnd(BOX_INNER_WIDTH)}
      </span>
      <span className={styles.border}>{'│'}</span>
      {'\n'}
      <span className={styles.border}>{`  │  ${'─'.repeat(49)}   │`}</span>
      {'\n'}
      {STEPS.map((text, i) => (
        <StepRow key={text} text={text} index={i} />
      ))}
      <span className={styles.border}>{`  └${'─'.repeat(BOX_INNER_WIDTH)}┘`}</span>
      {'\n'}
      <span className={styles.connectorOut}>{'       │\n       ▼'}</span>
      {'\n'}
      <span className={styles.emitTitle}>{'  AsyncGenerator<AgentEvent>'}</span>
      {'\n'}
      {'       '}
      <span className={styles.border}>{'│ '}</span>
      <Event name="text_delta" at={0} />
      {', '}
      <Event name="thinking_delta" at={0.35} />
      {', '}
      <Event name="tool_start" at={0.7} />
      {', '}
      <Event name="tool_end" at={1.05} />
      {',\n       '}
      <span className={styles.border}>{'│ '}</span>
      <Event name="tool_progress" at={1.4} />
      {', '}
      <Event name="usage" at={1.75} />
      {', '}
      <Event name="done" at={2.1} />
      {', '}
      <Event name="error" at={2.45} />
      {'\n'}
      <span className={styles.border}>{'       ▼'}</span>
      {'\n'}
      {'  surfaces: '}
      <Surface name="cli" at={0} />
      {' · '}
      <Surface name="tui" at={0.25} />
      {' · '}
      <Surface name="vscode" at={0.5} />
      {' · '}
      <Surface name="email" at={0.75} />
      {' · '}
      <Surface name="telegram" at={1} />
      {' · '}
      <Surface name="slack" at={1.25} />
    </pre>
  );
}
