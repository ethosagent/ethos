import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

import ArchDiagramAnimated from '../components/ArchDiagramAnimated';
import HeroTerminal from '../components/HeroTerminal';
import PersonalityShowcase from '../components/PersonalityShowcase';
import styles from './index.module.css';

// Scroll-reveal wrapper — fires once at threshold 0.15. SSR- and no-JS-safe:
// content starts visible; only after the observer attaches (and only when the
// section is below the fold and motion is allowed) does it enter the hidden
// state, so JS failure never leaves invisible content. A one-shot fallback
// timer force-reveals if the observer never fires (some render contexts —
// e.g. full-page screenshot renderers — never deliver intersection entries),
// so no section can stay stranded at opacity 0.
function Reveal({ children }: { children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'initial' | 'hidden' | 'revealed'>('initial');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Already within (or above) the viewport — leave it visible, no flash.
    if (el.getBoundingClientRect().top < window.innerHeight) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setPhase('revealed');
            observer.disconnect();
            window.clearTimeout(fallback);
          }
        }
      },
      { threshold: 0.15 },
    );
    setPhase('hidden');
    observer.observe(el);
    // Safety net: if the observer hasn't fired within 2.5s, force-reveal.
    const fallback = window.setTimeout(() => {
      setPhase('revealed');
      observer.disconnect();
    }, 2500);
    return () => {
      observer.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);

  const className =
    phase === 'hidden' ? styles.revealHidden : phase === 'revealed' ? styles.revealIn : undefined;
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

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
      <div className={styles.heroLayout}>
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
            of specialists — researcher, engineer, reviewer, coach, operator — each with its own
            tools, memory, and model. Same conversation across Slack, Telegram, and your terminal.
            Boundaries the prompt can't talk its way out of.
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
        <div className={styles.heroTerminal}>
          <HeroTerminal />
        </div>
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
        <ArchDiagramAnimated />
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
      description="A team of AI specialists — researcher, engineer, reviewer, coach, operator — that remember you across Slack, Telegram, and your terminal."
    >
      <Hero />
      <Reveal>
        <TwoDoors />
      </Reveal>
      <Reveal>
        <PersonalityShowcase />
      </Reveal>
      <Reveal>
        <OrientationLinks />
      </Reveal>
      <Reveal>
        <ArchDiagram />
      </Reveal>
      <Reveal>
        <Compat />
      </Reveal>
    </Layout>
  );
}
