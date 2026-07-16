import Link from '@docusaurus/Link';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';

import PersonalityMark from '../PersonalityMark';
import { type LandingPersonality, PERSONALITIES, type PersonalityId } from '../personalities';
import styles from './styles.module.css';

// Personality showcase — three plates with the scroll flythrough
// treatment (data-fly="row", driven by the page loop). Clicking a plate
// syncs selection with the orbit hero via the lifted page state.

export interface PersonalityShowcaseProps {
  activeId: PersonalityId | null;
  onToggle: (id: PersonalityId) => void;
}

function PersonalityRow({
  personality,
  active,
  onToggle,
}: {
  personality: LandingPersonality;
  active: boolean;
  onToggle: (id: PersonalityId) => void;
}): ReactNode {
  return (
    <div className={styles.prowScene} data-fly="row">
      <div className={styles.prow}>
        <button
          type="button"
          className={clsx(styles.prowInner, active && styles.prowInnerActive)}
          data-pid={personality.id}
          style={{ ['--p-accent' as never]: personality.accent } as CSSProperties}
          onClick={() => onToggle(personality.id)}
        >
          <span className={styles.pmark}>
            <PersonalityMark id={personality.id} accent={personality.accent} size={48} />
          </span>
          <span className={styles.prowBody}>
            <span className={styles.prowNameLine}>
              <span className={styles.prowName}>{personality.id}</span>
              <span className={styles.prowTagline}>{personality.tagline}</span>
            </span>
            <span className={styles.prowSample}>"{personality.sample}"</span>
            <span className={styles.prowTools}>
              {personality.tools.map((t, i) => (
                <span key={t}>
                  {i > 0 ? ' ' : ''}
                  <code>{t}</code>
                </span>
              ))}
            </span>
          </span>
          <span className={styles.prowMeta}>
            <span>
              <span className={styles.prowCountNum}>{personality.tools.length}</span>{' '}
              <span className={styles.prowCountLabel}>tools</span>
            </span>
            <span className={styles.prowModel}>
              <code>{personality.model}</code>
            </span>
            <span className={styles.prowScope}>
              memory · <code>personality:{personality.id}</code>
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

export default function PersonalityShowcase({
  activeId,
  onToggle,
}: PersonalityShowcaseProps): ReactNode {
  return (
    <section className={styles.showcase} id="personalities">
      <div className={styles.container}>
        <div className={styles.scene} data-fly="deep">
          <div>
            <div className={styles.sectionLabel}>specialists ship by default</div>
            <h2 className={styles.sectionTitle}>Personality, not "an agent."</h2>
            <div className={styles.lead}>
              <p>
                A generic agent has every tool. That is its problem. The toolset is the union of
                every task you might ever do, which is a security surface, a cost surface, and a
                quality surface. Voice is mush. Memory is a pile.
              </p>
              <p>
                Personalities invert it. Each has a curated toolset, a first-person identity (
                <code>SOUL.md</code>), and a memory scope. Researcher gets the 8 tools it needs.
                Reviewer gets 3 and a <code>per-personality</code> memory scope so its code-review
                notes never leak into the engineer's session.
              </p>
              <p className={styles.leadKicker}>
                Specialization, not configuration. Personality is architecture, not a system prompt
                in a costume.
              </p>
              <p className={styles.leadRouting}>
                routing: claude-fable-5 · gpt-5.6-sol · glm-5.2 · deepseek-v3.2 — per personality,
                set in config.yaml
              </p>
            </div>
          </div>
        </div>

        {PERSONALITIES.map((p) => (
          <PersonalityRow
            key={p.id}
            personality={p}
            active={activeId === p.id}
            onToggle={onToggle}
          />
        ))}

        <div className={styles.scene} data-fly="deep">
          <div className={styles.showcaseCta}>
            <Link to="/docs/using/explanation/what-is-a-personality" className={styles.ctaLink}>
              what is a personality? →
            </Link>
            <Link to="/docs/using/tutorials/first-personality" className={styles.ctaLink}>
              create your own →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
