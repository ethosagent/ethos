import type { CSSProperties, ReactNode } from 'react';

import styles from './styles.module.css';

// Flow-diagram version of the AgentLoop architecture on the landing page.
// Vertical pipeline of circular nodes: input ring → connector → AgentLoop
// panel (nine numbered circle steps on a spine) → connector → generator
// ring + event chips → connector → surface rings. Pure CSS keyframes on
// one shared 16s timeline (no JS timers) — same convention as
// HeroTerminal. Per-element stagger rides a `--d` custom property
// (inherited, so a row's circle and label share one delay). Timeline
// windows are documented in styles.module.css.
//
// aria-hidden on the diagram; the visually-hidden paragraph carries the
// text alternative.

const STEPS = [
  'resolve or create session',
  'fire session_start hooks',
  'persist user message',
  'load history (trimmed)',
  'prefetch memory (per personality scope)',
  'build system prompt from injectors',
  'before-prompt-build modifying hooks',
  'agentic loop (LLM stream → tool calls → LLM …)',
  'pre-flight hooks → execute tools → collect',
];

// Index of the "agentic loop" step — it gets the orbiting dot and a
// re-pulse (it loops).
const LOOP_STEP_INDEX = 7;

const EVENTS = [
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_end',
  'tool_progress',
  'usage',
  'done',
  'error',
];

const SURFACES = ['cli', 'tui', 'vscode', 'email', 'telegram', 'slack'];

function stagger(seconds: number): CSSProperties {
  return { ['--d' as never]: `${seconds}s` } as CSSProperties;
}

function StepRow({ text, index }: { text: string; index: number }): ReactNode {
  const isLoop = index === LOOP_STEP_INDEX;
  return (
    <div className={isLoop ? styles.stepRowLoop : styles.stepRow} style={stagger(index * 0.8)}>
      <span className={styles.stepCircleWrap}>
        <span className={isLoop ? styles.stepCircleLoop : styles.stepCircle}>{index + 1}</span>
        {isLoop && <span className={styles.orbit} />}
      </span>
      <span className={isLoop ? styles.stepLabelLoop : styles.stepLabel}>{text}</span>
    </div>
  );
}

export default function ArchDiagramAnimated(): ReactNode {
  return (
    <div className={styles.wrap}>
      <p className={styles.srOnly}>
        user input flows into AgentLoop.run's nine steps — session, hooks, memory, prompt, agentic
        loop — and streams out as an AsyncGenerator of AgentEvents to cli, tui, vscode, email,
        telegram, and slack surfaces.
      </p>
      <div className={styles.diagram} aria-hidden="true">
        {/* Input node */}
        <div className={styles.node}>
          <span className={`${styles.nodeRing} ${styles.inputRing}`} />
          <span className={`${styles.nodeLabel} ${styles.inputLabel}`}>user input</span>
        </div>

        {/* Connector: input → panel */}
        <div className={styles.connector}>
          <span className={`${styles.pulse} ${styles.pulseIn}`} />
        </div>

        {/* AgentLoop panel — nine steps on a spine */}
        <div className={styles.panel}>
          <div className={styles.panelHeader}>AgentLoop.run(input, options)</div>
          <div className={styles.panelBody}>
            <span className={styles.spine} />
            {STEPS.map((text, i) => (
              <StepRow key={text} text={text} index={i} />
            ))}
          </div>
        </div>

        {/* Connector: panel → generator */}
        <div className={styles.connector}>
          <span className={`${styles.pulse} ${styles.pulseOut}`} />
        </div>

        {/* Generator node + event chips */}
        <div className={styles.node}>
          <span className={`${styles.nodeRing} ${styles.genRing}`} />
          <span className={`${styles.nodeLabel} ${styles.genLabel}`}>
            {'AsyncGenerator<AgentEvent>'}
          </span>
        </div>
        <div className={styles.chips}>
          {EVENTS.map((name, i) =>
            name === 'done' ? (
              <span key={name} className={styles.chipDone}>
                {name}
              </span>
            ) : (
              <span key={name} className={styles.chip} style={stagger(i * 0.15)}>
                {name}
              </span>
            ),
          )}
        </div>

        {/* Connector: generator → surfaces */}
        <div className={styles.connector}>
          <span className={`${styles.pulse} ${styles.pulseSurf}`} />
        </div>

        {/* Surfaces row */}
        <div className={styles.surfaces}>
          {SURFACES.map((name, i) => (
            <span key={name} className={styles.surfaceItem} style={stagger(i * 0.2)}>
              <span className={styles.surfaceRing} />
              <span className={styles.surfaceLabel}>{name}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
