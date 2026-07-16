import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import OrbitHero from '../components/OrbitHero';
import PersonalityShowcase from '../components/PersonalityShowcase';
import { PERSONALITY_BY_ID, type PersonalityId } from '../components/personalities';
import TerminalSection from '../components/TerminalSection';
import styles from './index.module.css';

// Landing page — port of plan/hero-demos/demo-final-hybrid.html.
// Hero: orbital system (demo-2). Terminal: 3D tilting slab (demo-1).
// Everything else: scroll-driven flythrough plates, sticky conveyor, and
// progress rail (demo-3). SSR-safe: all content is visible pre-hydration;
// the fx class (scroll-driven 3D) is added only after mount and only when
// motion is allowed.

const doors = [
  {
    number: '01',
    label: 'Using Ethos',
    description:
      'Install the CLI, configure a provider, run your first chat, ship a Telegram bot. Five minutes to first message.',
    cta: 'Install →',
    to: '/docs/using/quickstart',
    kind: 'doorL',
  },
  {
    number: '02',
    label: 'Building on Ethos',
    description:
      'Write a tool, add an LLM provider, build a channel adapter, publish a plugin. Ten minutes to first commit.',
    cta: 'Build →',
    to: '/docs/building/quickstart',
    kind: 'doorR',
  },
];

const CONV_STEPS = [
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

// Index of the "agentic loop" step — it gets the orbiting dot (it loops).
const LOOP_STEP_INDEX = 7;

const CONV_EVENTS = [
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_end',
  'tool_progress',
  'usage',
  'done',
  'error',
];

const CONV_SURFACES: Array<{ name: string; arc: number }> = [
  { name: 'cli', arc: 34 },
  { name: 'tui', arc: 12 },
  { name: 'vscode', arc: 0 },
  { name: 'email', arc: 0 },
  { name: 'telegram', arc: 12 },
  { name: 'slack', arc: 34 },
];

const RAIL_ITEMS: Array<{ id: string; label: string }> = [
  { id: 'hero', label: 'hero' },
  { id: 'terminal', label: 'terminal' },
  { id: 'doors', label: 'doors' },
  { id: 'personalities', label: 'personalities' },
  { id: 'how', label: 'how it works' },
  { id: 'ecosystem', label: 'ecosystem' },
  { id: 'surfaces', label: 'surfaces' },
  { id: 'beyond', label: 'beyond chat' },
];

interface SurfaceRow {
  name: string;
  desc: string;
  detail: string;
  kind: 'fanL' | 'fanR';
  glyph: ReactNode;
}

const glyphProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const SURFACE_ROWS: SurfaceRow[] = [
  {
    name: 'CLI',
    desc: 'streaming chat with tool events, sessions persist across restarts',
    detail: 'ethos chat',
    kind: 'fanL',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <polyline points="3 4.5 7 8 3 11.5" />
        <line x1="8.5" y1="12" x2="13" y2="12" />
      </svg>
    ),
  },
  {
    name: 'Web app',
    desc: 'dashboard: sessions, personalities, memory, activity',
    detail: 'ethos serve --web',
    kind: 'fanR',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <ellipse cx="8" cy="8" rx="2.6" ry="6" />
        <line x1="2" y1="8" x2="14" y2="8" />
      </svg>
    ),
  },
  {
    name: 'Desktop app',
    desc: 'the same agent in its own window',
    detail: 'menu bar · native shell',
    kind: 'fanL',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <rect x="2" y="3" width="12" height="8" rx="1.5" />
        <line x1="6" y1="13.5" x2="10" y2="13.5" />
      </svg>
    ),
  },
  {
    name: 'Slack',
    desc: 'a channel adapter through one gateway',
    detail: 'same session · same memory',
    kind: 'fanR',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <path d="M14 10a1.5 1.5 0 0 1-1.5 1.5H8L5 14v-2.5H3.5A1.5 1.5 0 0 1 2 10V4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5Z" />
      </svg>
    ),
  },
  {
    name: 'Telegram',
    desc: 'multi-bot: one loop per bot token',
    detail: 'same session · same memory',
    kind: 'fanL',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <path d="M14 2 2 7l4.5 2L8 14l6-12Z" />
        <line x1="6.5" y1="9" x2="14" y2="2" />
      </svg>
    ),
  },
  {
    name: 'Discord',
    desc: 'the same dedup path as every adapter',
    detail: 'same session · same memory',
    kind: 'fanR',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <rect x="2.5" y="3.5" width="11" height="9" rx="4.5" />
      </svg>
    ),
  },
];

const SURFACE_MINIS: Array<{ name: string; glyph: ReactNode }> = [
  {
    name: 'VS Code',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <polyline points="6 3 3.5 3 3.5 13 6 13" />
        <polyline points="10 3 12.5 3 12.5 13 10 13" />
      </svg>
    ),
  },
  {
    name: 'TUI',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="1" strokeDasharray="2 2.2" />
      </svg>
    ),
  },
  {
    name: 'WhatsApp',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <rect x="4.5" y="2" width="7" height="12" rx="1.5" />
        <line x1="7" y1="12" x2="9" y2="12" />
      </svg>
    ),
  },
  {
    name: 'Email',
    glyph: (
      <svg {...glyphProps} aria-hidden="true">
        <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
        <polyline points="2.5 4.5 8 9 13.5 4.5" />
      </svg>
    ),
  },
];

const BEYOND_ROWS: Array<{
  kicker: string;
  heading: string;
  body: ReactNode;
  snippet: string;
}> = [
  {
    kicker: 'background tasks',
    heading: 'Fire a job, keep the conversation moving.',
    body: (
      <>
        <code>delegate_task</code> with <code>detached: true</code> returns a job id immediately —
        no waiting on the result. Jobs live in a durable store and survive restarts. Check in with{' '}
        <code>task_status</code>, <code>task_result</code>, <code>task_logs</code>, or{' '}
        <code>task_cancel</code>; each job carries its own <code>max_cost_usd</code> budget.
      </>
    ),
    snippet: 'delegate_task { detached: true } → job_7f2 · poll: task_status',
  },
  {
    kicker: 'cron',
    heading: 'Recurring runs, delivered where you read.',
    body: (
      <>
        Add <code>cron</code> to a personality's <code>toolset.yaml</code> and recurring runs —
        daily briefings, weekly reports — fire through the agent loop and deliver to your configured
        channels. Needs the long-lived <code>ethos gateway start</code>.
      </>
    ),
    snippet: 'toolset.yaml: + cron · ethos gateway start',
  },
  {
    kicker: 'custom skills',
    heading: 'Install skills — or reuse the ones you already have.',
    body: (
      <>
        Install from ClawHub, or point at skill libraries already on disk — Claude Code and OpenClaw
        formats parse as-is. Invoke with <code>/skill-name</code> in chat, or let them auto-load
        when relevant.
      </>
    ),
    snippet: 'ethos skills install steipete/slack · /skill-name',
  },
  {
    kicker: 'external plugins',
    heading: 'Plugins are default-deny.',
    body: (
      <>
        npm packages or local paths shipping tools, hooks, and injectors. Each personality opts in
        explicitly — a plugin unlisted in its <code>config.yaml</code> stays dormant.
      </>
    ),
    snippet: 'plugins: weather invoice-checker · ethos plugins',
  },
];

function clampNum(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function TwoDoors(): ReactNode {
  return (
    <section className={styles.doorsSection} id="doors">
      <div className={styles.container}>
        <div className={styles.scene} data-fly="deep">
          <div>
            <div className={styles.sectionLabel}>two doors</div>
          </div>
        </div>
        <div className={styles.doorGrid}>
          {doors.map((d) => (
            <div
              key={d.label}
              className={clsx(
                styles.doorScene,
                d.kind === 'doorL' ? styles.doorSceneL : styles.doorSceneR,
              )}
              data-fly={d.kind}
            >
              <Link className={styles.door} to={d.to}>
                <span className={styles.doorInner}>
                  <span className={styles.doorNumber}>{d.number}</span>
                  <span className={styles.doorLabel}>{d.label}</span>
                  <span className={styles.doorDesc}>{d.description}</span>
                  <span className={styles.doorCta}>{d.cta}</span>
                </span>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function OrientationTeaser(): ReactNode {
  return (
    <section className={styles.teaser} id="orientation">
      <div className={styles.container}>
        <div className={styles.scene} data-fly="deep">
          <p className={styles.teaserText}>
            <strong>New here?</strong> Read{' '}
            <Link to="/docs/getting-started/what-is-ethos">What is Ethos?</Link> for the 90-second
            mental model, <Link to="/docs/getting-started/why-ethos">Why Ethos?</Link> for the
            comparison to LangChain / CrewAI / OpenClaw / Hermes, and{' '}
            <Link to="/docs/getting-started/glossary">Glossary</Link> for every domain term.
          </p>
        </div>
      </div>
    </section>
  );
}

function Compat(): ReactNode {
  return (
    <section className={styles.compat} id="ecosystem">
      <div className={styles.container}>
        <div className={styles.scene} data-fly="deep">
          <div>
            <div className={styles.sectionLabel}>ecosystem</div>
            <h2 className={styles.sectionTitle}>Bring your existing setup.</h2>
            <p className={styles.sectionSubtitle}>
              OpenClaw users migrate in one command. Any clawhub skill installs into Ethos directly
              — the catalogue becomes your toolset, no forks, no shims.
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
                  Memory, skills, platform tokens, and API keys copy in place. Your{' '}
                  <code>SOUL.md</code> becomes a migrated personality; built-in matches resolve
                  automatically. Idempotent — safe to re-run.
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
        </div>
      </div>
    </section>
  );
}

function Surfaces(): ReactNode {
  return (
    <section className={styles.surfaces} id="surfaces">
      <div className={styles.container}>
        <div className={styles.scene} data-fly="deep">
          <div>
            <div className={styles.sectionLabel}>surfaces</div>
            <h2 className={styles.sectionTitle}>Runs where you work.</h2>
            <p className={styles.sectionSubtitle}>
              Every surface is a thin adapter in front of the same AgentLoop. Switch windows
              mid-conversation; the session comes with you.
            </p>
          </div>
        </div>
        <div className={styles.surfList}>
          {SURFACE_ROWS.map((row) => (
            <div
              key={row.name}
              className={clsx(styles.scene, styles.surfScene)}
              data-fly={row.kind}
            >
              <div className={styles.surfPlate}>
                <div className={styles.surfRow}>
                  <span className={styles.surfGlyph} aria-hidden="true">
                    {row.glyph}
                  </span>
                  <span className={styles.surfName}>{row.name}</span>
                  <span className={styles.surfDesc}>{row.desc}</span>
                  <span className={styles.surfDetail}>{row.detail}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className={styles.scene} data-fly="deep">
          <div>
            <div className={styles.surfSecondary}>
              {SURFACE_MINIS.map((mini) => (
                <span key={mini.name} className={styles.surfMini}>
                  <span className={styles.surfGlyph} aria-hidden="true">
                    {mini.glyph}
                  </span>
                  {mini.name}
                </span>
              ))}
            </div>
            <p className={styles.surfClosing}>
              one AgentLoop behind every surface — same sessions, same memory, same personality
              boundaries.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Beyond(): ReactNode {
  return (
    <section className={styles.beyond} id="beyond">
      <div className={styles.container}>
        <div className={styles.scene} data-fly="deep">
          <div className={styles.beyondIntro}>
            <div className={styles.sectionLabel}>beyond the chat window</div>
            <h2 className={styles.sectionTitle}>The loop keeps running when you stop typing.</h2>
            <p className={styles.sectionSubtitle}>
              Detached jobs, schedules, skills, and plugins all run through the same AgentLoop and
              the same personality boundaries — nothing gets a side door.
            </p>
          </div>
        </div>
        {BEYOND_ROWS.map((row) => (
          <div key={row.kicker} className={styles.scene} data-fly="deep">
            <div className={styles.beyondRow}>
              <div className={styles.beyondKicker}>{row.kicker}</div>
              <div>
                <h3 className={styles.beyondHeading}>{row.heading}</h3>
                <p className={styles.beyondBody}>{row.body}</p>
                <div className={styles.beyondSnippet}>{row.snippet}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LandingPage(): ReactNode {
  const [selection, setSelection] = useState<{ id: PersonalityId | null; pinned: boolean }>({
    id: null,
    pinned: false,
  });
  const [fx, setFx] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const railDotRef = useRef<HTMLSpanElement>(null);
  const convRef = useRef<HTMLElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const dollyRef = useRef<HTMLDivElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);

  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const select = useCallback((id: PersonalityId, pin: boolean) => {
    setSelection({ id, pinned: pin });
  }, []);
  const deselect = useCallback(() => {
    setSelection({ id: null, pinned: false });
  }, []);
  const toggleRow = useCallback(
    (id: PersonalityId) => {
      const cur = selectionRef.current;
      if (cur.id === id && cur.pinned) deselect();
      else select(id, true);
    },
    [select, deselect],
  );

  // Scroll-driven 3D only after mount and only when motion is allowed —
  // tracks mid-session reduced-motion flips too (the fx effect's cleanup
  // clears every inline transform it wrote).
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => setFx(!mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Clicking empty space resumes the orbit and restores the default accent.
  useEffect(() => {
    const onDocClick = (e: globalThis.MouseEvent): void => {
      if (selectionRef.current.id === null) return;
      const t = e.target;
      if (t instanceof Element && t.closest('[data-orbit-mark],[data-call-card],[data-pid]')) {
        return;
      }
      deselect();
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [deselect]);

  // Flythrough plates + conveyor dolly + progress rail — one rAF loop in fx
  // mode (batch reads, then writes); a rail-only scroll listener otherwise.
  useEffect(() => {
    const root = rootRef.current;
    const rail = railRef.current;
    const railDot = railDotRef.current;
    if (!root) return;

    const railLinks: HTMLAnchorElement[] = rail ? Array.from(rail.querySelectorAll('a')) : [];
    const railSections = railLinks.map((a) =>
      document.getElementById((a.getAttribute('href') ?? '#').slice(1)),
    );

    function readRailTops(): number[] {
      return railSections.map((s) =>
        s ? s.getBoundingClientRect().top : Number.POSITIVE_INFINITY,
      );
    }

    function writeRail(tops: number[]): void {
      let idx = 0;
      for (let k = 0; k < tops.length; k++) {
        const top = tops[k];
        if (top !== undefined && top <= window.innerHeight * 0.5) idx = k;
      }
      railLinks.forEach((a, j) => {
        a.classList.toggle(styles.railActive, j === idx);
      });
      const a = railLinks[idx];
      if (a && railDot) railDot.style.top = `${a.offsetTop + a.offsetHeight / 2 - 3}px`;
    }

    if (!fx) {
      // Static document: rail highlighting only, no 3D, no transforms.
      let pending = false;
      const onScroll = (): void => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          writeRail(readRailTops());
        });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      writeRail(readRailTops());
      return () => window.removeEventListener('scroll', onScroll);
    }

    /* ---------- flythrough plates ---------- */
    const flies = Array.from(root.querySelectorAll<HTMLElement>('[data-fly]')).map((scene) => ({
      scene,
      plate: scene.firstElementChild instanceof HTMLElement ? scene.firstElementChild : null,
      kind: scene.getAttribute('data-fly') ?? '',
    }));

    /* ---------- conveyor setup ---------- */
    const conv = convRef.current;
    const sticky = stickyRef.current;
    const dolly = dollyRef.current;
    const pulseEl = pulseRef.current;
    const SPACING = 240;
    const stationEls = dolly
      ? Array.from(dolly.querySelectorAll<HTMLElement>('[data-station]'))
      : [];
    stationEls.forEach((st, si) => {
      const isStep = st.hasAttribute('data-step');
      const xoff = isStep ? (si % 2 ? -72 : 72) : 0;
      const yoff = isStep ? (si % 2 ? 18 : -16) : 0;
      st.style.transform = `translate(-50%,-50%) translate3d(${xoff}px,${yoff}px,${-si * SPACING}px)`;
    });
    const stations = stationEls.map((el) => ({ el, lit: false, hidden: false }));
    const trackLen = SPACING * (stations.length - 1);

    /* ---------- one rAF loop: batch reads, then writes ---------- */
    let rafId: number;

    function flyFrame(now: number): void {
      rafId = requestAnimationFrame(flyFrame);

      /* READS */
      const vh = window.innerHeight;
      const flyRects = flies.map((f) => f.scene.getBoundingClientRect());
      const convRect = conv ? conv.getBoundingClientRect() : null;
      const stickyH = sticky ? sticky.offsetHeight : vh;
      const railTops = readRailTops();

      /* WRITES */
      /* scroll-flythrough plates */
      for (let f = 0; f < flies.length; f++) {
        const fly = flies[f];
        const r = flyRects[f];
        if (!fly?.plate || !r) continue;
        const e = easeOut(clampNum((vh - r.top) / (vh * 0.65), 0, 1));
        const l = clampNum((vh * 0.32 - r.bottom) / (vh * 0.32), 0, 1);
        const op = ((0.05 + 0.95 * e) * (1 - 0.45 * l)).toFixed(3);
        if (fly.kind === 'deep') {
          fly.plate.style.transform = `translateZ(${(-420 * (1 - e) - 100 * l).toFixed(2)}px) rotateX(${(6 * (1 - e)).toFixed(3)}deg)`;
        } else if (fly.kind === 'row') {
          fly.plate.style.transform = `rotateY(${(-14 * (1 - e)).toFixed(3)}deg) translateZ(${(-150 * (1 - e) - 60 * l).toFixed(2)}px)`;
        } else if (fly.kind === 'fanL' || fly.kind === 'fanR') {
          /* surface plates fan in from alternating angles to flat */
          fly.plate.style.transform = `rotateY(${((fly.kind === 'fanL' ? -10 : 10) * (1 - e)).toFixed(3)}deg) translateZ(${(-200 * (1 - e) - 60 * l).toFixed(2)}px)`;
        } else {
          /* doorL / doorR — CSS reads --ry so hover offsets can compose */
          const deg = (fly.kind === 'doorL' ? -12 : 12) * (1 - e);
          fly.plate.style.setProperty('--ry', `${deg.toFixed(3)}deg`);
        }
        fly.plate.style.opacity = op;
      }

      /* conveyor dolly */
      if (convRect && dolly && pulseEl) {
        const span = convRect.height - stickyH;
        const p = span > 0 ? clampNum(-convRect.top / span, 0, 1) : 0;
        const camZ = p * trackLen;
        dolly.style.transform = `translateZ(${camZ.toFixed(2)}px)`;
        for (let s = 0; s < stations.length; s++) {
          const stn = stations[s];
          if (!stn) continue;
          const d = s * SPACING - camZ; /* distance ahead of camera */
          const sop =
            d >= 0
              ? clampNum(1.15 - d / (SPACING * 3), 0, 1)
              : clampNum(1 + d / (SPACING * 0.9), 0, 1);
          stn.el.style.opacity = sop.toFixed(3);
          const hid = sop <= 0.01;
          if (hid !== stn.hidden) {
            stn.hidden = hid;
            stn.el.style.visibility = hid ? 'hidden' : 'visible';
          }
          const lit = Math.abs(d) < SPACING * 0.55;
          if (lit !== stn.lit) {
            stn.lit = lit;
            stn.el.classList.toggle(styles.lit, lit);
          }
        }
        /* traveling pulse — time-based, loops the whole track */
        const pz = ((now / 5200) % 1) * trackLen;
        const dd = pz - camZ;
        const pop =
          clampNum(1 - dd / (SPACING * 4), 0, 1) *
          clampNum((dd + SPACING * 0.8) / (SPACING * 0.5), 0, 1);
        pulseEl.style.transform = `translate(-50%,-50%) translate3d(0,70px,${(-pz).toFixed(2)}px)`;
        pulseEl.style.opacity = pop.toFixed(3);
      }

      /* rail */
      writeRail(railTops);
    }

    rafId = requestAnimationFrame(flyFrame);
    return () => {
      cancelAnimationFrame(rafId);
      // Clear every inline style this loop wrote, so flipping fx off
      // (reduced-motion change) leaves the plain static document.
      for (const fly of flies) {
        if (!fly.plate) continue;
        fly.plate.style.transform = '';
        fly.plate.style.opacity = '';
        fly.plate.style.removeProperty('--ry');
      }
      for (const stn of stations) {
        stn.el.style.transform = '';
        stn.el.style.opacity = '';
        stn.el.style.visibility = '';
        stn.el.classList.remove(styles.lit);
      }
      if (dolly) dolly.style.transform = '';
      if (pulseEl) {
        pulseEl.style.transform = '';
        pulseEl.style.opacity = '';
      }
    };
  }, [fx]);

  const onRailClick = useCallback((e: MouseEvent<HTMLAnchorElement>, id: string): void => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }, []);

  const accent = selection.id === null ? undefined : PERSONALITY_BY_ID[selection.id].accent;

  return (
    <div
      ref={rootRef}
      className={clsx(styles.landing, fx && 'landing-fx')}
      style={accent ? ({ ['--landing-accent' as never]: accent } as CSSProperties) : undefined}
    >
      <nav className={styles.rail} ref={railRef} aria-label="sections">
        <span className={styles.railTrack} aria-hidden="true" />
        <span className={styles.railDot} ref={railDotRef} aria-hidden="true" />
        {RAIL_ITEMS.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={styles.railLink}
            onClick={(e) => onRailClick(e, item.id)}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <OrbitHero
        selectedId={selection.id}
        pinned={selection.pinned}
        onSelect={select}
        onDeselect={deselect}
      />
      <TerminalSection />
      <TwoDoors />
      <PersonalityShowcase activeId={selection.id} onToggle={toggleRow} />
      <OrientationTeaser />

      {/* How it works — sticky 3D conveyor. Sits directly under the landing
          root: never inside a transformed or perspective wrapper, which
          would break position:sticky. */}
      <section className={styles.conveyor} id="how" ref={convRef}>
        <div className={styles.convSticky} ref={stickyRef}>
          <div className={styles.convCopy}>
            <div className={styles.sectionLabel}>how it works</div>
            <h2 className={styles.sectionTitle}>AgentLoop is one async generator.</h2>
            <p className={styles.sectionSubtitle}>
              Every component is an interface in <code>@ethosagent/types</code>, injected at
              construction. Personality decides which tools enter the loop and which model handles
              the turn.
            </p>
            <Link to="/docs/getting-started/architecture-90-seconds" className={styles.archLink}>
              Architecture in 90 seconds →
            </Link>
          </div>
          <p className={styles.srOnly}>
            user input flows into AgentLoop.run's nine steps — session, hooks, memory, prompt,
            agentic loop — and streams out as an AsyncGenerator of AgentEvents to cli, tui, vscode,
            email, telegram, and slack surfaces.
          </p>
          <div className={styles.convStage} aria-hidden="true">
            <div className={styles.convRunLabel}>AgentLoop.run(input, options)</div>
            <div className={styles.convDolly} ref={dollyRef}>
              <div className={clsx(styles.station, styles.stNode)} data-station>
                <span className={styles.nodeRing} />
                <span className={styles.nodeLabel}>user input</span>
              </div>
              {CONV_STEPS.map((text, i) => (
                <div
                  key={text}
                  className={clsx(
                    styles.station,
                    styles.stStep,
                    i === LOOP_STEP_INDEX && styles.stStepLoop,
                  )}
                  data-station
                  data-step
                >
                  <span className={styles.stepCircleWrap}>
                    <span className={styles.stepNum}>{i + 1}</span>
                    {i === LOOP_STEP_INDEX && <span className={styles.stepOrbit} />}
                  </span>
                  <span className={styles.stepText}>{text}</span>
                </div>
              ))}
              <div className={clsx(styles.station, styles.stNode)} data-station>
                <span className={clsx(styles.nodeRing, styles.nodeRingGen)} />
                <span className={styles.nodeLabel}>{'AsyncGenerator<AgentEvent>'}</span>
              </div>
              <div className={clsx(styles.station, styles.stChips)} data-station>
                {CONV_EVENTS.map((name) => (
                  <span
                    key={name}
                    className={clsx(styles.achip, name === 'done' && styles.achipDone)}
                  >
                    {name}
                  </span>
                ))}
              </div>
              <div className={clsx(styles.station, styles.stSurfaces)} data-station>
                {CONV_SURFACES.map((s) => (
                  <span
                    key={s.name}
                    className={styles.surfaceItem}
                    style={{ ['--arc' as never]: `${s.arc}px` } as CSSProperties}
                  >
                    <span className={styles.surfaceRing} />
                    <span className={styles.surfaceLabel}>{s.name}</span>
                  </span>
                ))}
              </div>
              <div className={styles.convPulse} ref={pulseRef} />
            </div>
          </div>
        </div>
      </section>

      <Compat />
      <Surfaces />
      <Beyond />
    </div>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Stop asking one agent to do everything"
      description="A team of AI specialists — researcher, engineer, reviewer — that remember you across Slack, Telegram, and your terminal."
    >
      <LandingPage />
    </Layout>
  );
}
