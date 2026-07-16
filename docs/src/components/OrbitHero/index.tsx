import Link from '@docusaurus/Link';
import clsx from 'clsx';
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';

import PersonalityMark from '../PersonalityMark';
import {
  type LandingPersonality,
  PERSONALITIES,
  PERSONALITY_INDEX,
  type PersonalityId,
} from '../personalities';
import styles from './styles.module.css';

// Orbital hero — text left, 3D orbital system right. One rAF loop drives
// the orbit, the idle dispatch dot, the rising tool-call chips, and the
// fixed starfield canvas. Hover selects, click pins; selection lifts to
// the page (accent re-theme + showcase sync) via onSelect/onDeselect.
// Reduced motion: static three-mark ring, selection still works.

const HERO_TITLE_WORDS = ['Stop', 'asking', 'one', 'agent', 'to', 'do', 'everything.'];

const TAU = Math.PI * 2;
const N = PERSONALITIES.length;
const STEP = TAU / N;
const FRONT = Math.PI / 2; // z = sin(theta) is max here → front-center
const TILT_Y = 0.32;
const IDLE_SPEED = 0.28; // rad/s
const MAX_CHIPS = 3;
const DOT_DURATION = 0.95; // seconds of dispatch-dot travel
const CHIP_DURATION = 2.4; // rise + hold + relay
const REFUSE_DURATION = 2.6; // rise + hold + fall-back dissolve
const CHIP_LANES = [0, 1, 2];

const DARK_GREYS = ['#2A2A2A', '#2F2F2F', '#343434', '#3A3A3A'];
const LIGHT_GREYS = ['#D8D8D4', '#D0D0CC', '#C8C8C4', '#C0C0BC'];

interface Star {
  x: number;
  y: number;
  z: number;
  r: number;
  vx: number;
  vy: number;
  c: string;
}

interface Flight {
  lane: number;
  idx: number;
  t: number;
  refused: boolean;
  refuseShown: boolean;
  jx: number;
  holdY: number;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function wrapDiff(target: number, current: number): number {
  let d = (target - current) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export interface OrbitHeroProps {
  selectedId: PersonalityId | null;
  pinned: boolean;
  onSelect: (id: PersonalityId, pin: boolean) => void;
  onDeselect: () => void;
}

export default function OrbitHero({
  selectedId,
  pinned,
  onSelect,
  onDeselect,
}: OrbitHeroProps): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<SVGSVGElement>(null);
  const ellipseRef = useRef<SVGEllipseElement>(null);
  const dispatchRef = useRef<HTMLDivElement>(null);
  const emitRef = useRef<HTMLDivElement>(null);
  const starsRef = useRef<HTMLCanvasElement>(null);
  const markRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const chipRefs = useRef<Array<HTMLDivElement | null>>([]);
  const relayRefs = useRef<Array<HTMLDivElement | null>>([]);

  const selRef = useRef<{ idx: number | null }>({ idx: null });
  const killChipsRef = useRef<() => void>(() => {});

  // Keep the rAF loop's view of the selection current, and clear in-flight
  // chips the moment something is selected (matches the reference).
  useEffect(() => {
    selRef.current.idx = selectedId === null ? null : PERSONALITY_INDEX[selectedId];
    if (selectedId !== null) killChipsRef.current();
  }, [selectedId]);

  useEffect(() => {
    const stage = stageRef.current;
    const guide = guideRef.current;
    const guideEllipse = ellipseRef.current;
    const dot = dispatchRef.current;
    const emitRing = emitRef.current;
    const canvas = starsRef.current;
    if (!stage || !guide || !guideEllipse || !dot || !emitRing || !canvas) return;

    const markEls: HTMLButtonElement[] = [];
    for (const el of markRefs.current) {
      if (el) markEls.push(el);
    }
    const chipEls: HTMLDivElement[] = [];
    for (const el of chipRefs.current) {
      if (el) chipEls.push(el);
    }
    const relayEls: HTMLDivElement[] = [];
    for (const el of relayRefs.current) {
      if (el) relayEls.push(el);
    }
    if (markEls.length !== N || chipEls.length !== MAX_CHIPS || relayEls.length !== MAX_CHIPS) {
      return;
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = canvas.getContext('2d');

    const marks = markEls.map((el) => ({ el, x: 0, y: 0, z: 0 }));
    // JS drives positions via transforms from the stage origin — clear the
    // CSS no-JS fallback offsets first.
    for (const m of marks) {
      m.el.style.left = '0px';
      m.el.style.top = '0px';
    }

    let stageW = 0;
    let stageH = 0;
    let cx = 0;
    let cy = 0;
    let radius = 0;
    let baseAngle = -Math.PI / 2;
    let speed = IDLE_SPEED;

    function layoutMarks(): void {
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (!m) continue;
        const theta = baseAngle + i * STEP;
        const z = Math.sin(theta); // -1 (back) … +1 (front)
        const x = Math.cos(theta) * radius;
        const y = z * radius * TILT_Y;
        const depth = (z + 1) / 2; // 0…1
        const scale = 0.68 + 0.44 * depth;
        const opacity = 0.45 + 0.55 * depth;
        m.x = cx + x;
        m.y = cy + y;
        m.z = z;
        m.el.style.transform = `translate(-50%, -50%) translate(${(cx + x).toFixed(2)}px, ${(cy + y).toFixed(2)}px) scale(${scale.toFixed(3)})`;
        m.el.style.opacity = opacity.toFixed(3);
        m.el.style.zIndex = String(20 + Math.round(depth * 60));
      }
    }

    function measure(): void {
      if (!stage || !guide || !guideEllipse) return;
      const rect = stage.getBoundingClientRect();
      stageW = rect.width;
      stageH = rect.height;
      cx = stageW / 2;
      cy = stageH / 2 - 24; // leave room for the call card at the bottom
      radius = Math.min(stageW * 0.385, 230);
      guide.setAttribute('viewBox', `0 0 ${stageW} ${stageH}`);
      guideEllipse.setAttribute('cx', String(cx));
      guideEllipse.setAttribute('cy', String(cy));
      guideEllipse.setAttribute('rx', String(radius));
      guideEllipse.setAttribute('ry', String(radius * TILT_Y));
      if (reduced) layoutMarks();
    }

    /* ---------- dispatch dot + tool-call chips ---------- */
    let dispatch: { t: number; idx: number } | null = null;
    let dispatchWait = 2.2;
    let chipWait = 0.6; // first chip fires almost immediately
    let chipTargetCursor = Math.floor(Math.random() * N);
    let chipsSinceRefuse = 0;
    const flights: Flight[] = [];
    const laneBusy: boolean[] = CHIP_LANES.map(() => false);

    function resetSlot(lane: number): void {
      laneBusy[lane] = false;
      const el = chipEls[lane];
      const relay = relayEls[lane];
      if (el) {
        el.style.opacity = '0';
        el.style.boxShadow = '';
        el.style.borderColor = '';
        el.style.color = '';
      }
      if (relay) {
        relay.style.opacity = '0';
        relay.style.background = '';
      }
    }

    function killDispatch(): void {
      dispatch = null;
      if (dot) {
        dot.style.opacity = '0';
        dot.style.background = '';
      }
      for (const lane of CHIP_LANES) resetSlot(lane);
      flights.length = 0;
    }
    killChipsRef.current = killDispatch;

    function spawnChip(): void {
      let lane = -1;
      for (const l of CHIP_LANES) {
        if (!laneBusy[l]) {
          lane = l;
          break;
        }
      }
      if (lane < 0) return; // concurrency cap — never confetti
      const el = chipEls[lane];
      if (!el || !emitRing) return;

      // cycle personalities so variety shows quickly
      chipTargetCursor = (chipTargetCursor + 1 + Math.floor(Math.random() * 2)) % N;
      const idx = chipTargetCursor;
      const p = PERSONALITIES[idx];
      if (!p) return;
      // the enforcement beat: occasionally, when reviewer is the target,
      // the loop tries write_file — and the registry refuses it
      const refused = p.id === 'reviewer' && chipsSinceRefuse >= 3;
      const tool = refused
        ? 'write_file'
        : (p.flightTools[Math.floor(Math.random() * p.flightTools.length)] ?? 'read_file');
      chipsSinceRefuse = refused ? 0 : chipsSinceRefuse + 1;

      laneBusy[lane] = true;
      el.textContent = tool;
      el.style.borderColor = '';
      el.style.color = '';
      el.style.opacity = '0';
      flights.push({
        lane,
        idx,
        t: 0,
        refused,
        refuseShown: false,
        jx: (Math.random() - 0.5) * 48, // x jitter — successive chips don't stack
        holdY: 96 + lane * 27, // px above core center, per lane
      });

      // faint expanding ring from the core at emission
      emitRing.classList.remove(styles.coreEmitGo);
      void emitRing.offsetWidth;
      emitRing.classList.add(styles.coreEmitGo);
    }

    // Advances one chip flight; returns false when finished.
    function chipFrame(f: Flight, dt: number): boolean {
      f.t += dt / (f.refused ? REFUSE_DURATION : CHIP_DURATION);
      const el = chipEls[f.lane];
      const relay = relayEls[f.lane];
      const m = marks[f.idx];
      const p = PERSONALITIES[f.idx];
      if (!el || !relay || !m || !p) return false;

      if (f.t >= 1) {
        if (!f.refused) {
          // arrival — the receiving mark pulses in its own accent
          m.el.classList.remove(styles.recv);
          void m.el.offsetWidth; // restart animation
          m.el.classList.add(styles.recv);
        }
        resetSlot(f.lane);
        return false;
      }

      const RISE = 0.3;
      const HOLD_END = 0.6;
      let x = cx + f.jx;
      let y = cy;
      let scale = 1;
      let op = 1;

      if (f.t < RISE) {
        // rise up and out of the core
        const rt = easeInOut(f.t / RISE);
        x = cx + f.jx * (0.35 + 0.65 * rt);
        y = cy - 28 - (f.holdY - 28) * rt;
        op = Math.min(1, f.t / 0.05);
        el.style.boxShadow = '';
      } else if (f.t < HOLD_END) {
        // readable hold above the core: pulse, glow, accent takeover
        const ht = (f.t - RISE) / (HOLD_END - RISE);
        y = cy - f.holdY - 3 * ht;
        const pulse = Math.sin(Math.min(1, ht * 1.6) * Math.PI);
        scale = 1 + 0.07 * pulse;
        el.style.boxShadow = `0 0 ${(3 + 10 * pulse).toFixed(1)}px ${p.accent}66`;
        if (ht > 0.45) {
          el.style.borderColor = p.accent;
          el.style.color = p.accent;
        }
      } else if (!f.refused) {
        // chip dissolves in place while a small accent dot relays to the mark
        const dtn = (f.t - HOLD_END) / (1 - HOLD_END);
        y = cy - f.holdY - 3;
        el.style.boxShadow = '';
        op = Math.max(0, 1 - dtn / 0.45);
        const e2 = easeInOut(dtn);
        const rx = x + (m.x - x) * e2;
        const ry = y + (m.y - y) * e2;
        relay.style.transform = `translate(${rx.toFixed(2)}px, ${ry.toFixed(2)}px)`;
        relay.style.background = p.accent;
        relay.style.opacity = dtn < 0.08 ? String(dtn * 12) : '1';
      } else {
        // refused: flash red, fall back toward the core, dissolve — no relay
        const ft = (f.t - HOLD_END) / (1 - HOLD_END);
        if (!f.refuseShown) {
          f.refuseShown = true;
          el.textContent = 'write_file ';
          const fx = document.createElement('span');
          fx.className = styles.flightRefused;
          fx.textContent = '✗ refused';
          el.appendChild(fx);
          el.style.borderColor = '#F87171';
          el.style.color = '#F87171';
          el.style.boxShadow = '';
          m.el.classList.remove(styles.refusedFlash);
          void m.el.offsetWidth;
          m.el.classList.add(styles.refusedFlash);
        }
        y = cy - f.holdY - 3 + 34 * easeInOut(ft);
        scale = 1 - 0.05 * ft;
        op = ft < 0.4 ? 1 : 1 - (ft - 0.4) / 0.6;
      }

      el.style.transform =
        `translate(-50%, -50%) translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)` +
        (scale !== 1 ? ` scale(${scale.toFixed(3)})` : '');
      el.style.opacity = op.toFixed(3);
      return true;
    }

    function updateDispatch(dt: number): void {
      if (reduced || selRef.current.idx !== null || !dot) return;

      // plain dispatch dot — single-flight
      if (!dispatch) {
        dispatchWait -= dt;
        if (dispatchWait <= 0) {
          // target the currently-nearest (front-most) mark
          let best = 0;
          for (let i = 1; i < marks.length; i++) {
            const mi = marks[i];
            const mb = marks[best];
            if (mi && mb && mi.z > mb.z) best = i;
          }
          dispatch = { t: 0, idx: best };
          dot.style.background = '';
        }
      } else {
        dispatch.t += dt / DOT_DURATION;
        const m = marks[dispatch.idx];
        const p = PERSONALITIES[dispatch.idx];
        if (!m || !p) {
          dispatch = null;
        } else if (dispatch.t >= 1) {
          // arrival — the receiving mark pulses in its own accent
          m.el.classList.remove(styles.recv);
          void m.el.offsetWidth; // restart animation
          m.el.classList.add(styles.recv);
          dispatch = null;
          dot.style.opacity = '0';
          dot.style.background = '';
          dispatchWait = 2.6 + Math.random() * 1.8;
        } else {
          const e = easeInOut(Math.min(dispatch.t, 1));
          const x = cx + (m.x - cx) * e;
          const y = cy + (m.y - cy) * e;
          dot.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
          dot.style.opacity = dispatch.t < 0.1 ? String(dispatch.t * 10) : '1';
          if (dispatch.t > 0.82) dot.style.background = p.accent;
        }
      }

      // tool-call chips — busy loop cadence, capped concurrency
      chipWait -= dt;
      if (chipWait <= 0) {
        spawnChip();
        chipWait = 1.2 + Math.random() * 0.8;
      }
      for (let fi = flights.length - 1; fi >= 0; fi--) {
        const f = flights[fi];
        if (f && !chipFrame(f, dt)) flights.splice(fi, 1);
      }
    }

    /* ---------- starfield ---------- */
    let particles: Star[] = [];
    let pointerX = 0;
    let pointerY = 0;
    let parX = 0;
    let parY = 0;

    function palette(): string[] {
      return document.documentElement.getAttribute('data-theme') === 'dark'
        ? DARK_GREYS
        : LIGHT_GREYS;
    }

    function initStars(): void {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const greys = palette();
      const count = Math.min(90, Math.round((canvas.width * canvas.height) / 22000));
      particles = [];
      for (let i = 0; i < count; i++) {
        const z = 0.25 + Math.random() * 0.75;
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          z,
          r: 0.6 + z * 1.1,
          vx: (Math.random() - 0.5) * 3 * z,
          vy: (Math.random() - 0.5) * 1.5 * z,
          c: greys[Math.floor(Math.random() * greys.length)] ?? '#2A2A2A',
        });
      }
    }

    function drawStars(dt: number): void {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      parX += (pointerX - parX) * Math.min(1, dt * 4);
      parY += (pointerY - parY) * Math.min(1, dt * 4);
      for (const s of particles) {
        if (!reduced) {
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          if (s.x < -4) s.x = canvas.width + 4;
          if (s.x > canvas.width + 4) s.x = -4;
          if (s.y < -4) s.y = canvas.height + 4;
          if (s.y > canvas.height + 4) s.y = -4;
        }
        ctx.beginPath();
        ctx.fillStyle = s.c;
        ctx.arc(s.x + parX * 16 * s.z, s.y + parY * 16 * s.z, s.r, 0, TAU);
        ctx.fill();
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      pointerX = e.clientX / window.innerWidth - 0.5;
      pointerY = e.clientY / window.innerHeight - 0.5;
    };
    if (!reduced) window.addEventListener('pointermove', onPointerMove, { passive: true });

    // Re-tint the starfield when the docs theme toggles.
    const themeObserver = new MutationObserver(() => {
      initStars();
      if (reduced) drawStars(0);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    /* ---------- main loop ---------- */
    let rafId: number | null = null;
    let lastT: number | null = null;

    function orbitFrame(now: number): void {
      rafId = requestAnimationFrame(orbitFrame);
      if (lastT === null) {
        lastT = now;
        return;
      }
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;

      const selectedIdx = selRef.current.idx;
      const targetSpeed = selectedIdx === null ? IDLE_SPEED : 0;
      speed += (targetSpeed - speed) * Math.min(1, dt * 3);
      baseAngle += speed * dt;
      if (selectedIdx !== null) {
        const target = FRONT - selectedIdx * STEP;
        baseAngle += wrapDiff(target, baseAngle) * Math.min(1, dt * 5);
      }
      if (baseAngle > TAU) baseAngle -= TAU;
      if (baseAngle < -TAU) baseAngle += TAU;

      layoutMarks();
      updateDispatch(dt);
      drawStars(dt);
    }

    function startOrbit(): void {
      if (rafId !== null) return;
      lastT = null;
      rafId = requestAnimationFrame(orbitFrame);
    }
    function stopOrbit(): void {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    const onResize = (): void => {
      initStars();
      measure();
      if (reduced) drawStars(0);
    };
    window.addEventListener('resize', onResize);

    const onVisibility = (): void => {
      if (reduced) return;
      if (document.hidden) stopOrbit();
      else startOrbit();
    };
    document.addEventListener('visibilitychange', onVisibility);

    initStars();
    measure();

    if (reduced) {
      // Static ring: three marks evenly placed, no motion, no dispatch dots.
      // Selection and re-theming still work on click.
      baseAngle = -Math.PI / 2;
      layoutMarks();
      drawStars(0);
    } else {
      startOrbit();
    }

    return () => {
      stopOrbit();
      killChipsRef.current = () => {};
      themeObserver.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (!reduced) window.removeEventListener('pointermove', onPointerMove);
    };
  }, []);

  // Call-card content: hold the last selection so the card fades out with
  // its content intact.
  const lastSelectedRef = useRef<LandingPersonality | null>(null);
  const active = selectedId === null ? null : PERSONALITIES[PERSONALITY_INDEX[selectedId]];
  if (active) lastSelectedRef.current = active;
  const cardP = active ?? lastSelectedRef.current ?? PERSONALITIES[0];

  return (
    <section className={styles.hero} id="hero">
      {/* decorative, empty canvas — nothing for AT to announce */}
      <canvas ref={starsRef} className={styles.stars} />
      <div className={styles.container}>
        <div className={styles.heroGrid}>
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
              General-purpose AI is fine for small talk, mediocre at real work. Ethos gives you a
              team of specialists — researcher, engineer, reviewer — each with its own tools,
              memory, and model. Same conversation across Slack, Telegram, and your terminal.
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

          <div className={styles.orbitStage} ref={stageRef}>
            <p className={styles.srOnly}>
              One agent core with three orbiting personalities — researcher, engineer, reviewer.
              Every call the AgentLoop makes is shaped by a personality: hover or click a mark to
              see its model, tagline, and curated toolset.
            </p>
            <svg
              ref={guideRef}
              className={styles.orbitGuide}
              viewBox="0 0 600 460"
              aria-hidden="true"
            >
              <ellipse
                ref={ellipseRef}
                className={styles.orbitEllipse}
                cx="300"
                cy="206"
                rx="225"
                ry="72"
              />
            </svg>
            <div className={styles.core} aria-hidden="true">
              <span className={styles.coreLabel}>AgentLoop</span>
            </div>
            <div ref={dispatchRef} className={styles.dispatchDot} aria-hidden="true" />
            {PERSONALITIES.map((p, i) => (
              <button
                key={p.id}
                type="button"
                data-orbit-mark
                ref={(el) => {
                  markRefs.current[i] = el;
                }}
                className={clsx(styles.orbitMark, selectedId === p.id && styles.orbitMarkSel)}
                aria-label={`personality ${p.id}`}
                style={{ ['--pulse' as never]: `${p.accent}55` } as CSSProperties}
                onPointerEnter={() => {
                  if (!pinned) onSelect(p.id, false);
                }}
                onPointerLeave={() => {
                  if (!pinned && selectedId === p.id) onDeselect();
                }}
                onClick={() => onSelect(p.id, true)}
              >
                <span className={styles.orbitDisc}>
                  <PersonalityMark id={p.id} accent={p.accent} size={48} />
                </span>
                <span className={styles.orbitLabel}>{p.id}</span>
              </button>
            ))}
            {CHIP_LANES.map((lane) => (
              <div key={lane}>
                <div
                  ref={(el) => {
                    chipRefs.current[lane] = el;
                  }}
                  className={styles.toolFlight}
                  aria-hidden="true"
                />
                <div
                  ref={(el) => {
                    relayRefs.current[lane] = el;
                  }}
                  className={styles.chipTrail}
                  aria-hidden="true"
                />
              </div>
            ))}
            <div ref={emitRef} className={styles.coreEmit} aria-hidden="true" />
            <div
              data-call-card
              className={clsx(styles.callCard, selectedId !== null && styles.callCardShow)}
              aria-live="polite"
            >
              {cardP && (
                <>
                  <div className={styles.callCardHead}>
                    <span className={styles.callCardMark}>
                      <PersonalityMark id={cardP.id} accent={cardP.accent} size={26} />
                    </span>
                    <span className={styles.callCardName}>{cardP.id}</span>
                    <span className={styles.callCardModel}>{cardP.model}</span>
                  </div>
                  <div className={styles.callCardTagline}>{cardP.tagline}</div>
                  <div className={styles.callCardTools}>
                    {cardP.tools.map((t) => (
                      <span key={t} className={styles.toolChip}>
                        {t}
                      </span>
                    ))}
                    {cardP.id === 'reviewer' && (
                      <span className={clsx(styles.toolChip, styles.toolChipRefused)}>
                        write_file <span className={styles.toolChipX}>✗</span> refused
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
