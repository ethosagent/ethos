import { dateToDayOffset, dayOffsetToDate } from './world-logic';

/** Scrubs the graph back in time; the right end is "now" (value null). */
export function DateSlider({
  bounds,
  value,
  onChange,
}: {
  bounds: { min: string; max: string } | null;
  value: string | null;
  onChange: (date: string | null) => void;
}) {
  if (!bounds) return <p className="world-small">No dated links to scrub through.</p>;
  const last = dateToDayOffset(bounds.min, bounds.max);
  const current = value ? dateToDayOffset(bounds.min, value) : last;
  return (
    <label className="world-slider">
      <span className="world-micro">as of</span>
      <input
        type="range"
        aria-label="Graph date"
        min={0}
        max={last}
        value={Math.min(Math.max(current, 0), last)}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(n >= last ? null : dayOffsetToDate(bounds.min, n));
        }}
      />
      <span className="world-mono">{value ?? 'now'}</span>
    </label>
  );
}
