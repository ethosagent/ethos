import Link from '@docusaurus/Link';
import type { ReactNode } from 'react';

import PersonalityMark from '../PersonalityMark';
import styles from './styles.module.css';

interface Personality {
  id: string;
  accent: string;
  model: string;
  tagline: string;
  sample: string;
  // Actual tool names from extensions/personalities/data/<id>/toolset.yaml
  tools: string[];
}

const personalities: Personality[] = [
  {
    id: 'researcher',
    accent: '#4A9EFF',
    model: 'claude-opus-4-7',
    tagline: 'methodical · cites sources · flags uncertainty',
    sample:
      'There are three families. The first is dense embedding retrieval, used by most open-source vector stores.',
    tools: [
      'web_search',
      'web_extract',
      'web_crawl',
      'read_file',
      'search_files',
      'memory_read',
      'memory_write',
      'session_search',
    ],
  },
  {
    id: 'engineer',
    accent: '#4ADE80',
    model: 'claude-sonnet-4-6',
    tagline: 'terse · code-first · runs commands to verify',
    sample:
      'On it. Plan: move apps/tui/src/agent-bridge.ts to packages/agent-bridge, update tui imports.',
    tools: [
      'terminal',
      'read_file',
      'write_file',
      'patch_file',
      'search_files',
      'web_search',
      'web_extract',
      'execute_code',
      'run_tests',
      'lint',
    ],
  },
  {
    id: 'reviewer',
    accent: '#F59E0B',
    model: 'claude-sonnet-4-6',
    tagline: 'critical · evidence-based · always explains why',
    sample: 'Two real concerns. The token rotation logic at auth.ts:47 has a TOCTOU race.',
    tools: ['read_file', 'search_files', 'session_search'],
  },
  {
    id: 'coach',
    accent: '#E879F9',
    model: 'claude-opus-4-7',
    tagline: 'warm but direct · question-led · helps you think',
    sample: 'OK. Stuck on what specifically? Walk me through what you tried so far.',
    tools: ['web_search', 'web_extract', 'memory_read', 'memory_write', 'session_search'],
  },
  {
    id: 'operator',
    accent: '#94A3B8',
    model: 'claude-sonnet-4-6',
    tagline: 'cautious · confirms before destructive · documents everything',
    sample: 'Found 247 run logs older than 30 days totaling 4.2MB. Will dry-run first. OK?',
    tools: [
      'terminal',
      'read_file',
      'write_file',
      'patch_file',
      'search_files',
      'execute_code',
      'run_tests',
    ],
  },
];

function PersonalityRow({ personality }: { personality: Personality }): ReactNode {
  return (
    <div className={styles.row} style={{ ['--accent' as never]: personality.accent }}>
      <div className={styles.mark}>
        <PersonalityMark id={personality.id} accent={personality.accent} size={48} />
      </div>
      <div className={styles.body}>
        <div className={styles.nameLine}>
          <span className={styles.name}>{personality.id}</span>
          <span className={styles.tagline}>{personality.tagline}</span>
        </div>
        <div className={styles.sample}>"{personality.sample}"</div>
        <div className={styles.toolList}>
          {personality.tools.map((t, i) => (
            <span key={t}>
              {i > 0 ? ' ' : ''}
              <code>{t}</code>
            </span>
          ))}
        </div>
      </div>
      <div className={styles.meta}>
        <div className={styles.metaCount}>
          <span className={styles.metaCountNum}>{personality.tools.length}</span>{' '}
          <span className={styles.metaCountLabel}>tools</span>
        </div>
        <div className={styles.metaModel}>
          <code>{personality.model}</code>
        </div>
        <div className={styles.metaScope}>
          memory · <code>personality:{personality.id}</code>
        </div>
      </div>
    </div>
  );
}

export default function PersonalityShowcase(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.sectionLabel}>specialists ship by default</div>
        <h2 className={styles.sectionTitle}>Personality, not "an agent."</h2>

        <div className={styles.lead}>
          <p>
            A generic agent has every tool. That is its problem. The toolset is the union of every
            task you might ever do, which is a security surface, a cost surface, and a quality
            surface. Voice is mush. Memory is a pile.
          </p>
          <p>
            Personalities invert it. Each has a curated toolset, a first-person identity (
            <code>SOUL.md</code>), and a memory scope. Researcher gets the 8 tools it needs.
            Reviewer gets 3 and a <code>per-personality</code> memory scope so its code-review notes
            never leak into your coach session.
          </p>
          <p className={styles.leadKicker}>
            Specialization, not configuration. Personality is architecture, not a system prompt in a
            costume.
          </p>
        </div>

        <div className={styles.rows}>
          {personalities.map((p) => (
            <PersonalityRow key={p.id} personality={p} />
          ))}
        </div>

        <div className={styles.cta}>
          <Link to="/docs/using/explanation/what-is-a-personality" className={styles.ctaLink}>
            what is a personality? →
          </Link>
          <Link to="/docs/using/tutorials/first-personality" className={styles.ctaLink}>
            create your own →
          </Link>
        </div>
      </div>
    </section>
  );
}
