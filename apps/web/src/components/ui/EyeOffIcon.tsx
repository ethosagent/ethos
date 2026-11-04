// Eye-off glyph for incognito sessions (DESIGN.md §Icons: stroke, currentColor,
// 1.5 stroke width). Colour comes from the parent; the icon never sets it.
export function EyeOffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 8s2.3-4 6.5-4c1 0 1.9.2 2.7.6M14.5 8s-2.3 4-6.5 4c-1 0-1.9-.2-2.7-.6" />
      <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" />
      <path d="M2.5 2.5l11 11" />
    </svg>
  );
}
