import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import type { CSSProperties, ReactNode } from 'react';

import PersonalityShowcase from '../components/PersonalityShowcase';
import styles from './index.module.css';

const HERO_TITLE_WORDS = ['Stop', 'asking', 'one', 'agent', 'to', 'do', 'everything.'];

const doors = [
  {
    number: '01',
    label: 'Using Ethos',
    description:
      'Install the CLI, configure a provider, run your first chat, ship a Telegram bot. Five minutes to first message.',
    cta: 'Install →',
    to: '/docs/using/quickstart',
  },
  {
    number: '02',
    label: 'Building on Ethos',
    description:
      'Write a tool, add an LLM provider, build a channel adapter, publish a plugin. Ten minutes to first commit.',
    cta: 'Build →',
    to: '/docs/building/quickstart',
  },
];

function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroStripe} aria-hidden="true" />
        <p className={styles.heroEyebrow}>ethos</p>
        <h1 className={styles.heroTitle}>
          {HERO_TITLE_WORDS.map((word, i) => (
            <span
              key={word}
              className={styles.heroWord}
              style={{ ['--i' as never]: i } as CSSProperties}
            >
              {word}
            </span>
          ))}
        </h1>
        <p className={styles.heroSubtitle}>
          General-purpose AI is fine for small talk, mediocre at real work. Ethos gives you a team
          of specialists — researcher, engineer, reviewer, coach, operator — each good at its one
          job. Same conversation across Slack, Telegram, and your terminal.
        </p>
        <div className={styles.heroActions}>
          <Link className={styles.btnPrimary} to="/docs/using/quickstart">
            Use Ethos
          </Link>
          <Link className={styles.btnGhost} to="/docs/building/quickstart">
            Build on Ethos
          </Link>
        </div>
        <p className={styles.heroMeta}>
          mit · node 24 · typescript strict · zero deps in the types layer
        </p>
      </div>
    </section>
  );
}

function TwoDoors() {
  return (
    <section className={styles.fastPaths}>
      <div className="container">
        <div className={styles.sectionLabel}>two doors</div>
        <div className={styles.pathRows}>
          {doors.map((p) => (
            <Link key={p.label} to={p.to} className={styles.pathRow}>
              <span className={styles.pathNumber}>{p.number}</span>
              <span className={styles.pathLabel}>{p.label}</span>
              <span className={styles.pathDescription}>{p.description}</span>
              <span className={styles.pathCta}>{p.cta}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function OrientationLinks() {
  return (
    <section className={styles.teaser}>
      <div className="container">
        <p className={styles.teaserText}>
          <strong>New here?</strong> Read{' '}
          <Link to="/docs/getting-started/what-is-ethos">What is Ethos?</Link> for the 90-second
          mental model, <Link to="/docs/getting-started/why-ethos">Why Ethos?</Link> for the
          comparison to LangChain / CrewAI / OpenClaw / Hermes, and{' '}
          <Link to="/docs/getting-started/glossary">Glossary</Link> for every domain term.
        </p>
      </div>
    </section>
  );
}

function ArchDiagram() {
  return (
    <section className={styles.arch}>
      <div className="container">
        <div className={styles.sectionLabel}>how it works</div>
        <h2 className={styles.sectionTitle}>AgentLoop is one async generator.</h2>
        <p className={styles.sectionSubtitle}>
          Every component is an interface in <code>@ethosagent/types</code>, injected at
          construction. Personality decides which tools enter the loop and which model handles the
          turn.
        </p>
        <pre className={styles.archDiagram}>
          {`  user input
       │
       ▼
  ┌──────────────────────────────────────────────────────┐
  │  AgentLoop.run(input, options)                       │
  │  ─────────────────────────────────────────────────   │
  │  1. resolve or create session                        │
  │  2. fire session_start hooks                         │
  │  3. persist user message                             │
  │  4. load history (trimmed)                           │
  │  5. prefetch memory (per personality scope)          │
  │  6. build system prompt from injectors               │
  │  7. before-prompt-build modifying hooks              │
  │  8. agentic loop (LLM stream → tool calls → LLM ...) │
  │  9. pre-flight hooks → execute tools → collect       │
  └──────────────────────────────────────────────────────┘
       │
       ▼
  AsyncGenerator<AgentEvent>
       │ text_delta, thinking_delta, tool_start, tool_end,
       │ tool_progress, usage, done, error
       ▼
  surfaces: cli · tui · vscode · email · telegram · slack`}
        </pre>
        <Link to="/docs/getting-started/architecture-90-seconds" className={styles.archLink}>
          Architecture in 90 seconds →
        </Link>
      </div>
    </section>
  );
}

function Compat() {
  return (
    <section className={styles.compat}>
      <div className="container">
        <div className={styles.sectionLabel}>ecosystem</div>
        <h2 className={styles.sectionTitle}>Bring your existing setup.</h2>
        <p className={styles.sectionSubtitle}>
          OpenClaw users migrate in one command. Any clawhub skill installs into Ethos directly —
          the catalogue becomes your toolset, no forks, no shims.
        </p>
        <div className={styles.compatRows}>
          <div className={styles.compatRow}>
            <div className={styles.compatHeading}>
              <span className={styles.compatBadge}>migrate</span>
              <span className={styles.compatTitle}>from openclaw</span>
            </div>
            <pre className={styles.compatCommand}>
              {`$ ethos claw migrate --dry-run
# preview the plan, then re-run without --dry-run`}
            </pre>
            <p className={styles.compatNote}>
              Memory, skills, platform tokens, and API keys copy in place. Your <code>SOUL.md</code>{' '}
              becomes a migrated personality; built-in matches resolve automatically. Idempotent —
              safe to re-run.
            </p>
          </div>
          <div className={styles.compatRow}>
            <div className={styles.compatHeading}>
              <span className={styles.compatBadge}>install</span>
              <span className={styles.compatTitle}>any clawhub skill</span>
            </div>
            <pre className={styles.compatCommand}>
              {`$ ethos skills install steipete/slack
# any slug clawhub serves, just works`}
            </pre>
            <p className={styles.compatNote}>
              The OpenClaw-compat layer parses <code>SKILL.md</code> frontmatter, environment
              substitutions, and OS gates — so the full clawhub catalogue runs unmodified inside
              your personality's toolset.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Stop asking one agent to do everything"
      description="A team of AI specialists — researcher, engineer, reviewer, coach, operator — instead of one general-purpose AI. Across Slack, Telegram, and your terminal."
    >
      <Hero />
      <TwoDoors />
      <PersonalityShowcase />
      <OrientationLinks />
      <ArchDiagram />
      <Compat />
    </Layout>
  );
}
