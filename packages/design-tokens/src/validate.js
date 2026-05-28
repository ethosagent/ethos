import { DEFAULT_TOKENS } from './index';
import { BUILTIN_SKINS, resolveSkin } from './skins';

// --- color helpers (small, no dependencies) ---------------------------------
function hexToRgb(hex) {
  const m = hex.replace(/^#/, '');
  if (m.length !== 6) return null;
  const n = Number.parseInt(m, 16);
  if (!Number.isFinite(n)) return null;
  return {
    r: (n >>> 16) & 0xff,
    g: (n >>> 8) & 0xff,
    b: n & 0xff,
  };
}
/**
 * Hue in degrees [0, 360). Returns null for greys (S = 0). Used to detect
 * the slop-blacklisted purple/violet/indigo band.
 */
export function hexToHue(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 1 / 255) return null; // grey
  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}
/** Relative luminance per WCAG 2.x. */
function luminance(rgb) {
  const channel = (c) => {
    const sRGB = c / 255;
    return sRGB <= 0.03928 ? sRGB / 12.92 : ((sRGB + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}
/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(fgHex, bgHex) {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  if (!fg || !bg) return 0;
  const lFg = luminance(fg);
  const lBg = luminance(bg);
  const [light, dark] = lFg > lBg ? [lFg, lBg] : [lBg, lFg];
  return (light + 0.05) / (dark + 0.05);
}
// --- rules ------------------------------------------------------------------
// Catches indigo (~240°) through purple (~285°). DESIGN.md coach at
// fuchsia (~292°) sits safely outside the upper bound. The plan called
// out [270, 290]; the band is widened on the indigo side because the
// real-world AI-slop gradient palette (Tailwind indigo/violet 500/600)
// lives between 240° and 270° — narrower bounds let the actual slop slip
// through.
const PURPLE_HUE_MIN = 240;
const PURPLE_HUE_MAX = 290;
const MIN_CONTRAST = 7; // WCAG AAA for body text — DESIGN.md targets ~14:1
const RADIUS_SCALE = new Set([4, 8, 14, 9999]);
const MOTION_MIN_MS = 0;
const MOTION_MAX_MS = 500;
const ALLOWED_FONT_TOKEN = 'Geist'; // substring match — Geist or Geist Mono both pass
export function validateTokens(tokens) {
  const findings = [];
  // Rule 1 — accents must not land in the purple/violet/indigo band.
  for (const [id, hex] of Object.entries(tokens.accents)) {
    const hue = hexToHue(hex);
    if (hue !== null && hue >= PURPLE_HUE_MIN && hue <= PURPLE_HUE_MAX) {
      findings.push({
        code: 'forbidden-accent-hue',
        message: `accent "${id}" (${hex}) lands at hue ${hue.toFixed(1)}° in the slop-blacklisted purple band [${PURPLE_HUE_MIN}, ${PURPLE_HUE_MAX}]`,
        path: `accents.${id}`,
      });
    }
  }
  // Rule 2 — body text vs base background must clear WCAG AAA.
  const ratio = contrastRatio(tokens.surface.textPrimary, tokens.surface.bgBase);
  if (ratio < MIN_CONTRAST) {
    findings.push({
      code: 'low-contrast',
      message: `textPrimary/bgBase contrast ratio ${ratio.toFixed(2)} is below the WCAG AAA threshold of ${MIN_CONTRAST}`,
      path: 'surface.textPrimary',
    });
  }
  // Rule 3 — typography stays Geist. Skins MUST NOT swap the font family
  // in v1; if they do, we reject so non-Geist fonts can never reach a
  // surface without a one-off design review.
  if (!tokens.typography.fontDisplay.includes(ALLOWED_FONT_TOKEN)) {
    findings.push({
      code: 'font-family-forbidden',
      message: `fontDisplay "${tokens.typography.fontDisplay}" does not include "${ALLOWED_FONT_TOKEN}" — typography is frozen in v1`,
      path: 'typography.fontDisplay',
    });
  }
  if (!tokens.typography.fontMono.includes(ALLOWED_FONT_TOKEN)) {
    findings.push({
      code: 'font-family-forbidden',
      message: `fontMono "${tokens.typography.fontMono}" does not include "${ALLOWED_FONT_TOKEN}" — typography is frozen in v1`,
      path: 'typography.fontMono',
    });
  }
  // Rule 4 — radius scale stays at DESIGN.md's 4/8/14/full. Prevents the
  // "borderRadius: 6" silent drift Phase 1 just collapsed.
  for (const [key, value] of Object.entries(tokens.radius)) {
    if (!RADIUS_SCALE.has(value)) {
      findings.push({
        code: 'radius-off-scale',
        message: `radius.${key} = ${value} is not on the DESIGN.md scale {4, 8, 14, 9999}`,
        path: `radius.${key}`,
      });
    }
  }
  // Rule 5 — motion durations cap at 500ms. 0 disables (acceptable for
  // reduced-motion mock skins); anything above 500ms is "marketing-app
  // whoosh" territory.
  const motionFields = ['fastMs', 'defaultMs', 'slowMs'];
  for (const key of motionFields) {
    const value = tokens.motion[key];
    if (value < MOTION_MIN_MS || value > MOTION_MAX_MS) {
      findings.push({
        code: 'motion-out-of-range',
        message: `motion.${key} = ${value}ms is outside the allowed range [${MOTION_MIN_MS}, ${MOTION_MAX_MS}]`,
        path: `motion.${key}`,
      });
    }
  }
  return { valid: findings.length === 0, findings };
}
/**
 * Resolve a skin against a base + registry and validate the result. Used
 * by skin loaders to reject invalid skins at load time. Throws ONLY if the
 * skin name is unknown / chain cycles — validation failures are returned
 * as a ValidationResult so the caller can choose to warn vs. crash.
 */
export function validateSkin(skin, base = DEFAULT_TOKENS, registry = BUILTIN_SKINS) {
  // The skin under test takes precedence over any same-named entry in the
  // registry — that way a user skin named "mono" replaces the built-in
  // for validation without leaking into the original registry.
  const fullRegistry = { ...registry, [skin.name]: skin };
  const resolved = resolveSkin(base, fullRegistry, skin.name);
  return validateTokens(resolved);
}
