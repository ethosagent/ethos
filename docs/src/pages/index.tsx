import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import InstallPill from '../components/InstallPill';
import shared from '../components/landing.module.css';
import OrbitHero from '../components/OrbitHero';
import { PERSONALITIES, PERSONALITY_BY_ID } from '../components/personalities';
import RingMark from '../components/RingMark';
import styles from './index.module.css';

// Landing page — port of the approved "Alive" mockup (ethos-home-alive.html).
// Hero + orbit stage live in OrbitHero; this file renders the ticker band,
// the roster, the duty band, the surfaces grid, and the CTA bubble. The
// Docusaurus navbar/footer replace the mockup's own header/footer, and the
// theme toggle is Docusaurus colorMode (light default). Copy is verbatim
// from the mockup.

const TICKER_ITEMS: Array<{ accent: string; who: string; what: string; via: string }> = [
  {
    accent: '#4A9EFF',
    who: 'researcher',
    what: 'sent the morning digest',
    via: 'telegram · 07:30',
  },
  {
    accent: '#4ADE80',
    who: 'engineer',
    what: 'fixed the flaky queue test',
    via: 'cli · this morning',
  },
  { accent: '#F59E0B', who: 'reviewer', what: 'held PR #482 — TOCTOU race', via: 'slack · today' },
  { accent: '#4A9EFF', who: 'researcher', what: 'summarized 3 new papers', via: 'memory · today' },
  { accent: '#4ADE80', who: 'engineer', what: 'shipped fix/export-stream', via: 'github · today' },
  {
    accent: '#F59E0B',
    who: 'reviewer',
    what: 'approved PR #479 after re-check',
    via: 'slack · today',
  },
  {
    accent: '#4A9EFF',
    who: 'researcher',
    what: 'answered "what broke in v0.19?"',
    via: 'whatsapp · today',
  },
  {
    accent: '#4ADE80',
    who: 'engineer',
    what: 'ran the suite ×50 — green',
    via: 'cli · this morning',
  },
];

const SCHEDULE_ROWS: Array<{ time: string; who: string; what: string; done: boolean }> = [
  { time: '07:30', who: 'researcher', what: 'sends the morning digest → telegram', done: true },
  { time: '09:00', who: 'engineer', what: 're-runs the flaky suite — 2 fixed', done: true },
  { time: 'hourly', who: 'reviewer', what: 'sweeps open PRs — #482 held', done: true },
  { time: '18:00', who: 'researcher', what: 'compiles what changed in your deps', done: false },
  { time: '02:00', who: 'gateway', what: 'backs up sessions + memory to one archive', done: false },
];

// Generic 19px stroke icons from the mockup — deliberately not brand logos.
const surfaceIconProps = {
  width: 19,
  height: 19,
  viewBox: '0 0 18 18',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
} as const;

const SURFACE_TILES: Array<{ name: string; desc: string; soon?: boolean; icon: ReactNode }> = [
  {
    name: 'CLI',
    desc: 'the whole framework in your terminal',
    icon: (
      <svg {...surfaceIconProps} aria-hidden="true">
        <rect x="1.5" y="2.5" width="15" height="13" rx="2" />
        <path d="M5 7l2.5 2L5 11M9.5 11.5h4" />
      </svg>
    ),
  },
  {
    name: 'Web app',
    desc: 'chat, sessions, dashboards, teams',
    icon: (
      <svg {...surfaceIconProps} aria-hidden="true">
        <rect x="1.5" y="2.5" width="15" height="13" rx="2" />
        <path d="M1.5 6h15M4 4.4h.01M6 4.4h.01" />
      </svg>
    ),
  },
  {
    name: 'Desktop app',
    desc: 'the team in your dock',
    icon: (
      <svg {...surfaceIconProps} aria-hidden="true">
        <rect x="1.5" y="2.5" width="15" height="10.5" rx="2" />
        <path d="M6.5 16h5M9 13v3" />
      </svg>
    ),
  },
  {
    name: 'Mobile app',
    desc: 'the team in your pocket',
    soon: true,
    icon: (
      <svg {...surfaceIconProps} aria-hidden="true">
        <rect x="5" y="1.5" width="8" height="15" rx="2" />
        <path d="M8 14.2h2" />
      </svg>
    ),
  },
  {
    name: 'VS Code',
    desc: 'extension — agents beside your code',
    icon: (
      <svg {...surfaceIconProps} aria-hidden="true">
        <path d="M6.5 4L2 9l4.5 5M11.5 4L16 9l-4.5 5" />
      </svg>
    ),
  },
  {
    name: 'JetBrains',
    desc: 'IntelliJ-family extension',
    icon: (
      <svg {...surfaceIconProps} aria-hidden="true">
        <path d="M6.5 4L2 9l4.5 5M11.5 4L16 9l-4.5 5" />
      </svg>
    ),
  },
];

function Ticker(): ReactNode {
  return (
    <section className={styles.tickBand} aria-label="Live activity across channels">
      <div className={styles.tick}>
        {[false, true].map((dup) => (
          <div
            key={dup ? 'dup' : 'main'}
            className={styles.tickHalf}
            aria-hidden={dup || undefined}
          >
            {TICKER_ITEMS.map((item) => (
              <span key={`${item.who}-${item.what}`} className={styles.ti}>
                <span className={styles.tdot} style={{ background: item.accent }} />
                <span className={styles.tiWho}>{item.who}</span>
                <span className={styles.tiWhat}>{item.what}</span>
                <span className={styles.tiVia}>{item.via}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Roster(): ReactNode {
  return (
    <section className={shared.block} id="roster">
      <div className={shared.wrap}>
        <p className={shared.kicker}>The roster</p>
        <h2 className={shared.h2}>Specialists, not a generalist with a nickname.</h2>
        <p className={shared.lead}>
          Every agent is a folder on your disk — a soul, a toolset, a model. The toolset is enforced
          by the framework, so an agent literally cannot use what it wasn't given.
        </p>
        <div className={styles.rosterScroll}>
          {PERSONALITIES.map((p) => (
            <div key={p.id} className={styles.rcard}>
              <div className={styles.rhead}>
                <RingMark accent={p.accent} size={44} />
                <div>
                  <div className={styles.rname}>{p.id}</div>
                  <div className={styles.rmodel}>{p.model}</div>
                </div>
              </div>
              <p className={styles.soul}>
                <em>{p.soulLine}</em> {p.soulBlurb}
              </p>
              <div className={styles.rlabel}>Toolset</div>
              <div className={styles.rtools}>
                {p.rosterTools.map((tool) => (
                  <span key={tool} className={styles.tchip}>
                    {tool}
                  </span>
                ))}
                {p.id === 'reviewer' && (
                  <span className={clsx(styles.tchip, styles.tchipNo)}>write_file ✗</span>
                )}
              </div>
            </div>
          ))}
          <div className={clsx(styles.rcard, styles.rcardMake)}>
            <div className={styles.makeBig}>+ Make your own</div>
            <p>A personality is three files in a folder:</p>
            <p>
              <code>SOUL.md</code> · <code>toolset.yaml</code> · <code>config.yaml</code>
            </p>
            <p>
              Drop it in <code>~/.ethos/personalities/</code> — it's live on the next message. No
              restart.
            </p>
            <Link
              className={clsx(shared.btn, styles.makeBtn)}
              to="/docs/using/tutorials/first-personality"
            >
              Write a SOUL.md
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Duty(): ReactNode {
  return (
    <div className={styles.dutyBand}>
      <div className={clsx(shared.wrap, styles.duty)}>
        <div>
          <p className={shared.kicker}>While you sleep</p>
          <h2 className={shared.h2}>Someone's always on duty.</h2>
          <p className={shared.lead}>
            Cron wakes agents on schedule; the gateway keeps every reply ledgered until it's
            delivered. Kill the process mid-task — messages replay, nothing is lost, nobody is
            billed twice.
          </p>
        </div>
        <div className={styles.schedule} role="img" aria-label="Today's agent schedule">
          <div className={styles.schedHead}>
            Today <span className={clsx(shared.mono, styles.schedMeta)}>3 agents · 5 jobs</span>
          </div>
          {SCHEDULE_ROWS.map((row) => (
            <div key={`${row.time}-${row.who}`} className={styles.srow}>
              <span className={styles.srowTime}>{row.time}</span>
              <span className={styles.srowText}>
                <b>{row.who}</b> {row.what}
              </span>
              <span className={clsx(styles.srowStatus, !row.done && styles.srowStatusWait)}>
                {row.done ? '✓ done' : 'scheduled'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Surfaces(): ReactNode {
  return (
    <section className={shared.block}>
      <div className={shared.wrap}>
        <p className={shared.kicker}>Take it everywhere</p>
        <h2 className={shared.h2}>Every surface. Same team.</h2>
        <p className={shared.lead}>
          However you work, the same agents answer — same sessions, same memory, same enforced
          toolsets.
        </p>
        <div className={styles.surfGrid}>
          {SURFACE_TILES.map((tile) => (
            <div key={tile.name} className={styles.surfTile}>
              {tile.icon}
              <div>
                <div className={styles.surfName}>{tile.name}</div>
                <div className={styles.surfDesc}>{tile.desc}</div>
              </div>
              {tile.soon && <span className={styles.soonTag}>soon</span>}
            </div>
          ))}
        </div>
        <div className={styles.protoRow}>
          <span className={styles.protoKey}>MCP</span>
          <span className={styles.protoText}>
            <b>Personality-based MCP server.</b> Expose the team over MCP and delegate a task
            straight to a personality — your MCP client asks, and the reviewer answers{' '}
            <em>as the reviewer</em>, toolset enforced.{' '}
            <Link to="/docs/using/how-to/use-as-mcp-server">How it works →</Link>
          </span>
        </div>
        <div className={styles.protoRow}>
          <span className={styles.protoKey}>ACP</span>
          <span className={styles.protoText}>
            <b>ACP server.</b> Ethos speaks the Agent Client Protocol, so ACP-native editors and
            agents can drive it like any other coding agent.
          </span>
        </div>
      </div>
    </section>
  );
}

function Cta(): ReactNode {
  const researcher = PERSONALITY_BY_ID.researcher;
  return (
    <section className={styles.cta}>
      <div className={shared.wrap}>
        <div className={styles.ctaBubble}>
          <div className={styles.ctaWho}>
            <RingMark accent={researcher.accent} size={18} /> researcher{' '}
            <span className={clsx(shared.mono, styles.ctaModel)}>{researcher.model}</span>
          </div>
          <h2 className={clsx(shared.h2, styles.ctaTitle)}>"Put a team on it."</h2>
          <p className={styles.ctaSub}>
            Two minutes to hello. Your keys, your machine, your roster.
          </p>
          <div className={styles.ctaRow}>
            <InstallPill />
            <Link className={clsx(shared.btn, shared.btnPop)} to="/docs/using/quickstart">
              Quickstart
            </Link>
          </div>
        </div>
        <div className={styles.ctaMarks} aria-hidden="true">
          {PERSONALITIES.map((p) => (
            <RingMark key={p.id} accent={p.accent} size={30} />
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Your AI team is already working"
      description="Ethos runs a whole team of specialist agents — in parallel, on every app you use. Each has its own tools, memory, and model, and none of them can overstep."
    >
      <div className={styles.landing}>
        <OrbitHero />
        <Ticker />
        <Roster />
        <Duty />
        <Surfaces />
        <Cta />
      </div>
    </Layout>
  );
}
