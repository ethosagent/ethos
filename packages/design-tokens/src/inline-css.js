import { accentFor } from './index';
/**
 * Returns a record of inline-style strings keyed by semantic role. Email
 * templates apply them like:
 *
 *   <p style={styles.body}>...
 *   <a style={styles.link} href="...">...
 */
export function tokensToInlineCss(tokens, options = {}) {
    const brand = accentFor(tokens, options.personalityId ?? 'researcher');
    const body = tokens.typography.scale.body;
    const h2 = tokens.typography.scale.h2;
    const small = tokens.typography.scale.small;
    // Hard-coded email-safe surface (white background, dark text) — DESIGN.md
    // says light mode only for email. Pulling from `tokens.surface` would
    // pick up dark-mode hex values that look terrible in Gmail/Outlook.
    const ink = '#1A1A1A';
    const muted = '#6B6B6A';
    const divider = '#E8E8E4';
    return {
        body: `margin:0;padding:0;font-family:${tokens.typography.fontDisplay};font-size:${body.px}px;line-height:${body.lineHeight};color:${ink};background:#FFFFFF;`,
        heading: `margin:0 0 ${tokens.spacing.md}px 0;font-family:${tokens.typography.fontDisplay};font-size:${h2.px}px;font-weight:${h2.weight};line-height:${h2.lineHeight};color:${ink};`,
        link: `color:${brand};text-decoration:underline;`,
        meta: `font-family:${tokens.typography.fontMono};font-size:${small.px}px;color:${muted};`,
        rule: `border:none;border-top:1px solid ${divider};margin:${tokens.spacing.lg}px 0;`,
        badge: `display:inline-block;padding:2px 8px;background:${brand};color:#FFFFFF;font-size:${small.px}px;font-weight:500;border-radius:${tokens.radius.sm}px;`,
    };
}
