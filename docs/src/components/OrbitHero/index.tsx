import clsx from 'clsx';
import { type CSSProperties, Fragment, type ReactNode, useEffect, useRef } from 'react';

import InstallPill from '../InstallPill';
import shared from '../landing.module.css';
import { PERSONALITIES } from '../personalities';
import RingMark from '../RingMark';
import styles from './styles.module.css';

// Hero + orbit stage — port of the approved "Alive" mockup
// (ethos-home-alive.html). One rAF loop drives the orbit, the idle dispatch
// dot, the rising tool-call chips, the speech bubbles, and the starfield
// canvas that spans the whole hero. Hover selects, click pins, click-outside
// or Escape unpins — selection is internal to the stage (no page re-theme).
// Reduced motion: static ring, one bubble on the front-most mark.
// SSR-safe: every window/document/canvas access lives inside useEffect.

const TAU = Math.PI * 2;
const N = PERSONALITIES.length;
const STEP = TAU / N;
const FRONT = Math.PI / 2; // z = sin(theta) is max here → front-center
const TILT = 0.3;
const IDLE = 0.26; // rad/s
const DOT_DURATION = 0.95; // seconds of dispatch-dot travel
const CHIP_DURATION = 2.4; // rise + hold + relay
const REFUSE_DURATION = 2.6; // rise + hold + fall-back dissolve
const CHIP_LANES = [0, 1, 2];
const BUBBLE_HOLD = 3.6; // seconds a bubble stays up

const LIGHT_GREYS = ['#DEDEDA', '#D7D7D2', '#D0D0CC', '#C9C9C3'];
const DARK_GREYS = ['#2A2A2A', '#2F2F2F', '#343434', '#3A3A3A'];

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

function accentTextVar(id: string): string {
  return `var(--ethos-accent-${id}-text)`;
}

// Backtick spans in bubble quotes render as <code>.
function renderQuote(quote: string): ReactNode {
  const parts = quote.split('`');
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reorders
      <code key={i}>{part}</code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reorders
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export default function OrbitHero(): ReactNode {
  const heroRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<SVGSVGElement>(null);
  const ellipseRef = useRef<SVGEllipseElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const emitRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const starsRef = useRef<HTMLCanvasElement>(null);
  const markRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const chipRefs = useRef<Array<HTMLDivElement | null>>([]);
  const trailRefs = useRef<Array<HTMLDivElement | null>>([]);
  const bubbleRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const hero = heroRef.current;
    const stage = stageRef.current;
    const guide = guideRef.current;
    const guideEllipse = ellipseRef.current;
    const core = coreRef.current;
    const emitRing = emitRef.current;
    const dot = dotRef.current;
    const canvas = starsRef.current;
    if (!hero || !stage || !guide || !guideEllipse || !core || !emitRing || !dot || !canvas) {
      return;
    }

    const markEls: HTMLButtonElement[] = [];
    for (const el of markRefs.current) {
      if (el) markEls.push(el);
    }
    const chipEls: HTMLDivElement[] = [];
    for (const el of chipRefs.current) {
      if (el) chipEls.push(el);
    }
    const trailEls: HTMLDivElement[] = [];
    for (const el of trailRefs.current) {
      if (el) trailEls.push(el);
    }
    const bubbleEls: HTMLDivElement[] = [];
    for (const el of bubbleRefs.current) {
      if (el) bubbleEls.push(el);
    }
    if (
      markEls.length !== N ||
      bubbleEls.length !== N ||
      chipEls.length !== CHIP_LANES.length ||
      trailEls.length !== CHIP_LANES.length
    ) {
      return;
    }

    // Narrowed aliases — hoisted function declarations below don't keep the
    // null-guard narrowing on the original consts.
    const dotEl: HTMLDivElement = dot;
    const emitEl: HTMLDivElement = emitRing;

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
    let speed = IDLE;
    let sel: number | null = null;
    let pinned = false;

    function layoutMarks(): void {
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (!m) continue;
        const theta = baseAngle + i * STEP;
        const z = Math.sin(theta); // -1 (back) … +1 (front)
        const x = Math.cos(theta) * radius;
        const y = z * radius * TILT;
        const depth = (z + 1) / 2; // 0…1
        m.x = cx + x;
        m.y = cy + y;
        m.z = z;
        m.el.style.transform = `translate(-50%, -50%) translate(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px) scale(${(0.66 + 0.46 * depth).toFixed(3)})`;
        m.el.style.opacity = (0.42 + 0.58 * depth).toFixed(3);
        m.el.style.zIndex = String(20 + Math.round(depth * 60));
      }
    }

    function measure(): void {
      if (!stage || !guide || !guideEllipse || !core || !emitRing) return;
      const rect = stage.getBoundingClientRect();
      stageW = rect.width;
      stageH = rect.height;
      cx = stageW / 2;
      cy = stageH / 2 - 6;
      radius = Math.min(stageW * 0.36, 235);
      guide.setAttribute('viewBox', `0 0 ${stageW} ${stageH}`);
      guideEllipse.setAttribute('cx', String(cx));
      guideEllipse.setAttribute('cy', String(cy));
      guideEllipse.setAttribute('rx', String(radius));
      guideEllipse.setAttribute('ry', String(radius * TILT));
      core.style.left = `${cx}px`;
      core.style.top = `${cy}px`;
      emitEl.style.left = `${cx}px`;
      emitEl.style.top = `${cy}px`;
      if (reduced) layoutMarks();
    }

    /* ---------- dispatch dot + tool-call chips ---------- */
    let dispatch: { t: number; idx: number } | null = null;
    let dispatchWait = 2.0;
    let chipWait = 0.5; // first chip fires almost immediately
    let chipTargetCursor = Math.floor(Math.random() * N);
    let chipsSinceRefuse = 0;
    const flights: Flight[] = [];
    const laneBusy: boolean[] = CHIP_LANES.map(() => false);

    function resetSlot(lane: number): void {
      laneBusy[lane] = false;
      const el = chipEls[lane];
      const trail = trailEls[lane];
      if (el) {
        el.style.opacity = '0';
        el.style.boxShadow = '';
        el.style.borderColor = '';
        el.style.color = '';
      }
      if (trail) {
        trail.style.opacity = '0';
        trail.style.background = '';
      }
    }

    function killAll(): void {
      dispatch = null;
      dotEl.style.opacity = '0';
      dotEl.style.background = '';
      for (const lane of CHIP_LANES) resetSlot(lane);
      flights.length = 0;
    }

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
      if (!el) return;

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
        jx: (Math.random() - 0.5) * 50, // x jitter — successive chips don't stack
        holdY: 100 + lane * 28, // px above core center, per lane
      });

      // faint expanding ring from the core at emission
      emitEl.classList.remove(styles.coreEmitGo);
      void emitEl.offsetWidth;
      emitEl.classList.add(styles.coreEmitGo);
    }

    // Advances one chip flight; returns false when finished.
    function chipFrame(f: Flight, dt: number): boolean {
      f.t += dt / (f.refused ? REFUSE_DURATION : CHIP_DURATION);
      const el = chipEls[f.lane];
      const trail = trailEls[f.lane];
      const m = marks[f.idx];
      const p = PERSONALITIES[f.idx];
      if (!el || !trail || !m || !p) return false;

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
        y = cy - 30 - (f.holdY - 30) * rt;
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
          el.style.color = accentTextVar(p.id);
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
        trail.style.transform = `translate(${rx.toFixed(2)}px, ${ry.toFixed(2)}px)`;
        trail.style.background = p.accent;
        trail.style.opacity = dtn < 0.08 ? String(dtn * 12) : '1';
      } else {
        // refused: flash red, fall back toward the core, dissolve — no relay
        const ft = (f.t - HOLD_END) / (1 - HOLD_END);
        if (!f.refuseShown) {
          f.refuseShown = true;
          el.textContent = 'write_file ';
          const fx = document.createElement('span');
          fx.className = styles.fx;
          fx.textContent = '✗ refused';
          el.appendChild(fx);
          el.style.borderColor = 'var(--ethos-error)';
          el.style.color = 'var(--ethos-error)';
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
      if (reduced || sel !== null) return;

      // plain dispatch dot — single-flight, targets the front-most mark
      if (!dispatch) {
        dispatchWait -= dt;
        if (dispatchWait <= 0) {
          let best = 0;
          for (let i = 1; i < marks.length; i++) {
            const mi = marks[i];
            const mb = marks[best];
            if (mi && mb && mi.z > mb.z) best = i;
          }
          dispatch = { t: 0, idx: best };
          dotEl.style.background = '';
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
          dotEl.style.opacity = '0';
          dotEl.style.background = '';
          dispatchWait = 2.6 + Math.random() * 1.8;
        } else {
          const e = easeInOut(Math.min(dispatch.t, 1));
          const x = cx + (m.x - cx) * e;
          const y = cy + (m.y - cy) * e;
          dotEl.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
          dotEl.style.opacity = dispatch.t < 0.1 ? String(dispatch.t * 10) : '1';
          if (dispatch.t > 0.82) dotEl.style.background = p.accent;
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

    /* ---------- speech bubbles — the front-most agent speaks ---------- */
    let bubbleT = 2.4;
    let bubbleOn = false;
    let bubbleIdx = -1;

    let bubbleHoldLeft = 0;

    function placeBubble(idx: number): void {
      const bubble = bubbleEls[idx];
      const m = marks[idx];
      if (!bubble || !m) return;
      // clamp inside the stage: bubble is translated -50% x and -100% y -58px
      const bw = bubble.offsetWidth || 300;
      const bh = bubble.offsetHeight || 88;
      const half = bw / 2;
      const x = Math.min(Math.max(m.x, half + 8), Math.max(half + 8, stageW - half - 8));
      const y = Math.max(m.y - 14, bh + 66);
      bubble.style.left = `${x}px`;
      bubble.style.top = `${y}px`;
    }

    function hideBubble(): void {
      const bubble = bubbleEls[bubbleIdx];
      if (bubble) bubble.classList.remove(styles.bubbleShow);
      bubbleOn = false;
    }

    function updateBubble(dt: number): void {
      if (reduced) return;
      if (bubbleOn) {
        bubbleHoldLeft -= dt;
        placeBubble(bubbleIdx);
        if (bubbleHoldLeft <= 0 || (sel !== null && sel !== bubbleIdx)) {
          hideBubble();
          bubbleT = sel !== null ? 1.0 : 2.8;
        }
        return;
      }
      bubbleT -= dt;
      if (bubbleT <= 0) {
        let idx: number;
        if (sel !== null) {
          idx = sel;
        } else {
          idx = 0;
          for (let i = 1; i < marks.length; i++) {
            const mi = marks[i];
            const mb = marks[idx];
            if (mi && mb && mi.z > mb.z) idx = i;
          }
        }
        const m = marks[idx];
        if (!m) return;
        if (m.z < 0.25) {
          // wait until the speaker rotates forward
          bubbleT = 0.12;
          return;
        }
        bubbleIdx = idx;
        placeBubble(idx);
        const bubble = bubbleEls[idx];
        if (bubble) bubble.classList.add(styles.bubbleShow);
        bubbleOn = true;
        bubbleHoldLeft = BUBBLE_HOLD;
      }
    }

    /* ---------- starfield — spans the whole hero, dpr-scaled ---------- */
    let particles: Star[] = [];
    let pointerX = 0;
    let pointerY = 0;
    let parX = 0;
    let parY = 0;
    let starsW = 0;
    let starsH = 0;

    function palette(): string[] {
      return document.documentElement.getAttribute('data-theme') === 'dark'
        ? DARK_GREYS
        : LIGHT_GREYS;
    }

    function initStars(): void {
      if (!canvas || !hero) return;
      const rect = hero.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      starsW = rect.width;
      starsH = rect.height;
      canvas.width = starsW * dpr;
      canvas.height = starsH * dpr;
      canvas.style.width = `${starsW}px`;
      canvas.style.height = `${starsH}px`;
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const greys = palette();
      const count = Math.min(80, Math.round((starsW * starsH) / 24000));
      particles = [];
      for (let i = 0; i < count; i++) {
        const z = 0.25 + Math.random() * 0.75;
        particles.push({
          x: Math.random() * starsW,
          y: Math.random() * starsH,
          z,
          r: 0.6 + z * 1.1,
          vx: (Math.random() - 0.5) * 3 * z,
          vy: (Math.random() - 0.5) * 1.5 * z,
          c: greys[Math.floor(Math.random() * greys.length)] ?? '#D0D0CC',
        });
      }
    }

    function drawStars(dt: number): void {
      if (!ctx) return;
      ctx.clearRect(0, 0, starsW, starsH);
      parX += (pointerX - parX) * Math.min(1, dt * 4);
      parY += (pointerY - parY) * Math.min(1, dt * 4);
      for (const s of particles) {
        if (!reduced) {
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          if (s.x < -4) s.x = starsW + 4;
          if (s.x > starsW + 4) s.x = -4;
          if (s.y < -4) s.y = starsH + 4;
          if (s.y > starsH + 4) s.y = -4;
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

    /* ---------- selection: hover selects, click pins ---------- */
    function select(i: number, pin: boolean): void {
      sel = i;
      pinned = pin || pinned;
      killAll();
      marks.forEach((m, j) => {
        m.el.classList.toggle(styles.markSel, j === i);
      });
      bubbleT = Math.min(bubbleT, 0.15);
    }

    function deselect(): void {
      sel = null;
      pinned = false;
      for (const m of marks) m.el.classList.remove(styles.markSel);
    }

    const markCleanups: Array<() => void> = [];
    marks.forEach((m, i) => {
      const onEnter = (): void => {
        if (!pinned) select(i, false);
      };
      const onLeave = (): void => {
        if (!pinned && sel === i) deselect();
      };
      const onClick = (): void => {
        if (pinned && sel === i) deselect();
        else select(i, true);
      };
      m.el.addEventListener('pointerenter', onEnter);
      m.el.addEventListener('pointerleave', onLeave);
      m.el.addEventListener('click', onClick);
      markCleanups.push(() => {
        m.el.removeEventListener('pointerenter', onEnter);
        m.el.removeEventListener('pointerleave', onLeave);
        m.el.removeEventListener('click', onClick);
      });
    });

    const onStageClick = (e: globalThis.MouseEvent): void => {
      const t = e.target;
      if (t instanceof Element && t.closest('[data-orbit-mark]')) return;
      deselect();
    };
    stage.addEventListener('click', onStageClick);

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') deselect();
    };
    window.addEventListener('keydown', onKeyDown);

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

    function frame(now: number): void {
      rafId = requestAnimationFrame(frame);
      if (lastT === null) {
        lastT = now;
        return;
      }
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;

      const targetSpeed = sel === null ? IDLE : 0;
      speed += (targetSpeed - speed) * Math.min(1, dt * 3);
      baseAngle += speed * dt;
      if (sel !== null) {
        baseAngle += wrapDiff(FRONT - sel * STEP, baseAngle) * Math.min(1, dt * 5);
      }
      if (baseAngle > TAU) baseAngle -= TAU;
      if (baseAngle < -TAU) baseAngle += TAU;

      layoutMarks();
      updateDispatch(dt);
      updateBubble(dt);
      drawStars(dt);
    }

    function startLoop(): void {
      if (rafId !== null) return;
      lastT = null;
      rafId = requestAnimationFrame(frame);
    }
    function stopLoop(): void {
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
      if (document.hidden) stopLoop();
      else startLoop();
    };
    document.addEventListener('visibilitychange', onVisibility);

    initStars();
    measure();
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        initStars();
        measure();
        if (reduced) drawStars(0);
      });
    }

    if (reduced) {
      // Static ring + one bubble on the front-most mark, so the scene isn't
      // mute. Selection still works on click.
      baseAngle = -Math.PI / 2;
      layoutMarks();
      drawStars(0);
      let idx = 0;
      for (let i = 1; i < marks.length; i++) {
        const mi = marks[i];
        const mb = marks[idx];
        if (mi && mb && mi.z > mb.z) idx = i;
      }
      bubbleIdx = idx;
      placeBubble(idx);
      const bubble = bubbleEls[idx];
      if (bubble) bubble.classList.add(styles.bubbleShow);
    } else {
      startLoop();
    }

    return () => {
      stopLoop();
      themeObserver.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
      stage.removeEventListener('click', onStageClick);
      for (const cleanup of markCleanups) cleanup();
      if (!reduced) window.removeEventListener('pointermove', onPointerMove);
    };
  }, []);

  return (
    <section ref={heroRef} className={styles.hero} id="hero">
      {/* decorative, empty canvas — nothing for AT to announce */}
      <canvas ref={starsRef} className={styles.stars} />
      <div className={clsx(shared.wrap, styles.heroInner)}>
        <span className={styles.heroBadge}>
          <span className={styles.liveDot} /> 3 agents on duty right now
        </span>
        <h1 className={styles.heroTitle}>
          Your AI team is{' '}
          <span className={styles.hl}>
            <i>already working.</i>
          </span>
        </h1>
        <p className={styles.heroSub}>
          Ethos runs <b>a whole team of specialist agents</b> — in parallel, on every app you use.
          One researches, one ships code, one guards the merge. Each has its own tools, memory, and
          model, and <b>none of them can overstep</b>.
        </p>
        <div className={styles.heroActions}>
          <InstallPill />
          <a className={clsx(shared.btn, shared.btnPop)} href="#roster">
            Meet the team
          </a>
        </div>
        <p className={clsx(styles.heroMeta, shared.mono)}>
          Open-source TypeScript framework · MIT · runs on your machine
        </p>
      </div>

      <div ref={stageRef} className={clsx(shared.wrap, styles.stage)}>
        <svg ref={guideRef} className={styles.orbitGuide} viewBox="0 0 600 470" aria-hidden="true">
          <ellipse
            ref={ellipseRef}
            className={styles.orbitEllipse}
            cx="300"
            cy="230"
            rx="230"
            ry="74"
          />
        </svg>
        <div ref={coreRef} className={styles.core} aria-hidden="true">
          <span className={styles.coreLabel}>AgentLoop</span>
        </div>
        <div ref={emitRef} className={styles.coreEmit} aria-hidden="true" />
        <div ref={dotRef} className={styles.dot} aria-hidden="true" />
        {PERSONALITIES.map((p, i) => (
          <button
            key={p.id}
            type="button"
            data-orbit-mark
            ref={(el) => {
              markRefs.current[i] = el;
            }}
            className={styles.mark}
            aria-label={`personality ${p.id}`}
            style={
              {
                ['--pulse' as never]: `${p.accent}55`,
                ['--accent' as never]: p.accent,
              } as CSSProperties
            }
          >
            <span className={styles.markDisc}>
              <RingMark accent={p.accent} size={56} />
            </span>
            <span className={styles.markLabel}>{p.id}</span>
          </button>
        ))}
        {CHIP_LANES.map((lane) => (
          <Fragment key={lane}>
            <div
              ref={(el) => {
                chipRefs.current[lane] = el;
              }}
              className={styles.flight}
              aria-hidden="true"
            />
            <div
              ref={(el) => {
                trailRefs.current[lane] = el;
              }}
              className={styles.trail}
              aria-hidden="true"
            />
          </Fragment>
        ))}
        {PERSONALITIES.map((p, i) => (
          <div
            key={p.id}
            ref={(el) => {
              bubbleRefs.current[i] = el;
            }}
            className={styles.bubble}
            style={{ borderColor: `${p.accent}66` }}
            aria-hidden="true"
          >
            <div className={styles.bubbleWho}>
              <RingMark accent={p.accent} size={16} /> {p.id}{' '}
              <span className={styles.bubbleModel}>{p.model}</span>
            </div>
            <div className={styles.bubbleText}>{renderQuote(p.quote)}</div>
          </div>
        ))}
        <p className={styles.srOnly}>
          Three agents orbit the loop and speak in turn — researcher, engineer, reviewer. Hover or
          click one to pin it.
        </p>
      </div>
    </section>
  );
}
