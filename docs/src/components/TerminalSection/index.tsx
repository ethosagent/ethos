import { type ReactNode, useEffect, useRef } from 'react';

import HeroTerminal from '../HeroTerminal';
import styles from './styles.module.css';

// Terminal section — copy block left, the HeroTerminal vignette in a 3D
// tilting slab right. The slab rests at rotateY(-6°) rotateX(2°) and tilts
// up to ±8° toward the cursor via a rAF lerp (handlers only update
// targets; transform-only writes). Reduced motion: flat slab, no glare.

const REST_RX = 2; // resting pose rotateX
const REST_RY = -6; // resting pose rotateY
const MAX_TILT = 8; // max degrees toward the cursor

export default function TerminalSection(): ReactNode {
  const sectionRef = useRef<HTMLElement>(null);
  const slabRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const slab = slabRef.current;
    const glareSpot = glareRef.current;
    if (!section || !slab || !glareSpot) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const cur = { rx: REST_RX, ry: REST_RY, gx: 0, gy: 0 };
    const target = { rx: REST_RX, ry: REST_RY, gx: 0, gy: 0 };
    let rafId: number;

    function tick(): void {
      rafId = requestAnimationFrame(tick);
      let moved = false;
      for (const k of ['rx', 'ry', 'gx', 'gy'] as const) {
        const next0 = cur[k] + (target[k] - cur[k]) * 0.09;
        const next = Math.abs(next0 - target[k]) < 0.002 ? target[k] : next0;
        if (next !== cur[k]) {
          cur[k] = next;
          moved = true;
        }
      }
      if (moved && slab && glareSpot) {
        slab.style.transform = `rotateX(${cur.rx.toFixed(3)}deg) rotateY(${cur.ry.toFixed(3)}deg)`;
        glareSpot.style.transform = `translate3d(${cur.gx.toFixed(2)}px,${cur.gy.toFixed(2)}px,0)`;
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!slab) return;
      const r = slab.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      let nx = ((e.clientX - r.left) / r.width - 0.5) * 2; // -1..1 at slab edges
      let ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
      nx = Math.max(-1, Math.min(1, nx));
      ny = Math.max(-1, Math.min(1, ny));
      target.ry = REST_RY + nx * MAX_TILT;
      target.rx = REST_RX - ny * MAX_TILT;
      target.gx = nx * r.width * 0.22;
      target.gy = ny * r.height * 0.22;
    };

    const onPointerLeave = (): void => {
      target.rx = REST_RX;
      target.ry = REST_RY;
      target.gx = 0;
      target.gy = 0;
    };

    section.addEventListener('pointermove', onPointerMove);
    section.addEventListener('pointerleave', onPointerLeave);
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      section.removeEventListener('pointermove', onPointerMove);
      section.removeEventListener('pointerleave', onPointerLeave);
    };
  }, []);

  return (
    <section className={styles.terminalSection} id="terminal" ref={sectionRef}>
      <div className={styles.container}>
        <div className={styles.terminalGrid}>
          <div className={styles.scene} data-fly="deep">
            <div>
              <div className={styles.sectionLabel}>one conversation</div>
              <p className={styles.termCopyText}>
                Three specialists, one session. Switch personality mid-conversation; memory and
                boundaries follow.
              </p>
            </div>
          </div>

          <div className={styles.slabScene}>
            <div className={styles.terminalSlab} ref={slabRef}>
              <HeroTerminal />
              <div className={styles.terminalGlare}>
                <div className={styles.terminalGlareSpot} ref={glareRef} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
