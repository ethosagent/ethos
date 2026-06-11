import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';

import PersonalityMark from '../PersonalityMark';
import styles from './styles.module.css';

// Self-cycling terminal vignette — three acts on a shared 16s pure-CSS
// timeline (no JS timers). Acts are stacked absolutely-positioned layers
// crossfaded by keyframe windows; lines within an act fade in staggered
// via per-line animation-delay on one shared keyframe.

const ACCENTS = {
  researcher: '#4A9EFF',
  engineer: '#4ADE80',
  reviewer: '#F59E0B',
} as const;

function Line({
  delay,
  className,
  children,
}: {
  delay: number;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      className={clsx(styles.line, className)}
      style={{ animationDelay: `${delay}s` } as CSSProperties}
    >
      {children}
    </div>
  );
}

function Prompt({ delay, children }: { delay: number; children: ReactNode }): ReactNode {
  return (
    <Line delay={delay} className={styles.prompt}>
      <span className={styles.promptYou}>you ▸</span> {children}
    </Line>
  );
}

function AgentHeader({ delay, id }: { delay: number; id: keyof typeof ACCENTS }): ReactNode {
  const accent = ACCENTS[id];
  return (
    <Line delay={delay} className={styles.agentHeader}>
      <PersonalityMark id={id} accent={accent} size={20} />
      <span className={styles.agentName}>{id}</span>
      <span className={styles.agentStripe} style={{ background: accent } as CSSProperties} />
    </Line>
  );
}

export default function HeroTerminal(): ReactNode {
  return (
    <div className={styles.wrap}>
      <p className={styles.srOnly}>
        One conversation, three specialists: the researcher finds a race condition, the engineer
        patches it, and the reviewer checks the diff — but is refused write access because
        write_file is not in its toolset.
      </p>
      <div className={styles.terminal} aria-hidden="true">
        <div className={styles.titleBar}>
          <span className={styles.titleText}>ethos chat</span>
          <span className={styles.statusDot} />
        </div>
        <div className={styles.body}>
          {/* Act 1 — researcher, ~0–5s */}
          <div className={clsx(styles.act, styles.actResearcher)}>
            <Prompt delay={0.3}>is our auth token rotation safe?</Prompt>
            <AgentHeader delay={0.9} id="researcher" />
            <Line delay={1.5}>
              <span className={styles.chip}>
                web_search <span className={styles.ok}>✓</span> 0.8s
              </span>
            </Line>
            <Line delay={2.1} className={styles.response}>
              Three findings. The rotation window at auth.ts:47 has a TOCTOU race —
            </Line>
          </div>

          {/* Act 2 — engineer, ~5–10s */}
          <div className={clsx(styles.act, styles.actEngineer)}>
            <Prompt delay={5.3}>/personality engineer — fix it</Prompt>
            <AgentHeader delay={5.9} id="engineer" />
            <div className={styles.chipRow}>
              <Line delay={6.4}>
                <span className={styles.chip}>
                  read_file auth.ts <span className={styles.ok}>✓</span>
                </span>
              </Line>
              <Line delay={6.8}>
                <span className={styles.chip}>
                  patch_file <span className={styles.ok}>✓</span>
                </span>
              </Line>
              <Line delay={7.2}>
                <span className={styles.chip}>
                  run_tests <span className={styles.ok}>✓</span> 14 passed
                </span>
              </Line>
            </div>
            <Line delay={7.8} className={styles.response}>
              Patched with a compare-and-swap. Tests green.
            </Line>
          </div>

          {/* Act 3 — reviewer, ~10–16s (the money frame) */}
          <div className={clsx(styles.act, styles.actReviewer)}>
            <Prompt delay={10.3}>/personality reviewer — check the diff</Prompt>
            <AgentHeader delay={10.9} id="reviewer" />
            <Line delay={11.5}>
              <span className={styles.chip}>
                read_file auth.diff <span className={styles.ok}>✓</span>
              </span>
            </Line>
            <Line delay={12.1}>
              <span className={clsx(styles.chip, styles.chipRefused)}>
                write_file <span className={styles.err}>✗</span>{' '}
                <span className={styles.err}>refused</span> — not in toolset.yaml
              </span>
            </Line>
            <Line delay={12.9} className={styles.caption}>
              Reviewer can't edit the code it reviews. Enforced by the registry, not the prompt.
            </Line>
          </div>
        </div>
        <div className={styles.footer}>same session · same memory · cli ⇄ telegram ⇄ slack</div>
      </div>
    </div>
  );
}
