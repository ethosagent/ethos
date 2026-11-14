// DESIGN.md --warning (dark skin), "Pending review".
export const ATTENTION_DOT_COLOR = '#F59E0B';

const SIZE = 32;
const DOT = { cx: 24, cy: 8, r: 7 } as const;

export interface FaviconContext {
  clearRect(...a: number[]): void;
  drawImage(img: unknown, ...a: number[]): void;
  beginPath(): void;
  arc(...a: number[]): void;
  fill(): void;
  fillStyle: string;
}

export interface FaviconCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): FaviconContext | null;
  toDataURL(type: 'image/png'): string;
}

export interface FaviconDeps {
  createCanvas(size: number): FaviconCanvas;
  loadImage(href: string): Promise<unknown>;
}

/** Draws the base icon with an attention dot; PNG data URL, or null when canvas/image is unavailable. */
export async function renderDotFavicon(
  baseHref: string,
  deps: FaviconDeps,
): Promise<string | null> {
  try {
    const img = await deps.loadImage(baseHref);
    const canvas = deps.createCanvas(SIZE);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    ctx.beginPath();
    ctx.arc(DOT.cx, DOT.cy, DOT.r, 0, Math.PI * 2);
    ctx.fillStyle = ATTENTION_DOT_COLOR;
    ctx.fill();
    return canvas.toDataURL('image/png');
  } catch {
    // Image load failure or a tainted-canvas SecurityError: no dot, tab keeps its plain icon.
    return null;
  }
}

export const browserFaviconDeps: FaviconDeps = {
  createCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    // Adapter instead of a cast: DOM's arc/drawImage signatures are narrower than FaviconContext's.
    return {
      width: size,
      height: size,
      getContext() {
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        return {
          clearRect: (x, y, w, h) => ctx.clearRect(x, y, w, h),
          drawImage: (img, x, y, w, h) => {
            if (img instanceof HTMLImageElement) ctx.drawImage(img, x, y, w, h);
          },
          beginPath: () => ctx.beginPath(),
          arc: (x, y, r, start, end) => ctx.arc(x, y, r, start, end),
          fill: () => ctx.fill(),
          set fillStyle(v: string) {
            ctx.fillStyle = v;
          },
          get fillStyle() {
            return String(ctx.fillStyle);
          },
        };
      },
      toDataURL: (type) => canvas.toDataURL(type),
    };
  },
  loadImage(href) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`favicon load failed: ${href}`));
      img.src = href;
    });
  },
};
