// The "I want a quiet terminal" skin. Surface tokens unchanged; every
// personality accent collapses to text-secondary so the per-personality
// fingerprint goes away. Useful for screenshots, neurodivergent users
// who find the color overhead noisy, or terminals with poor ANSI hue
// rendering.
//
// The literal hex matches DESIGN.md `--text-secondary` (dark) — inlined
// here rather than read from DEFAULT_TOKENS to avoid the circular import
// (this module loads before main index.ts finishes evaluating). The
// design-md-parity test catches drift if either side moves.
const muted = '#9A9A98';
export const monoSkin = {
    name: 'mono',
    description: 'Desaturated — every personality renders in text-secondary grey.',
    extends: 'default',
    tokens: {
        accents: {
            researcher: muted,
            engineer: muted,
            reviewer: muted,
            coach: muted,
            operator: muted,
        },
    },
};
