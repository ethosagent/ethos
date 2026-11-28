import type { GuidanceMapping, InitiativeFileWire } from '@ethosagent/web-contracts';
import { FILE_ROWS } from './model';

/** What a guidance line resolved to. Advice, never permission. */
function guidanceNote(g: GuidanceMapping): string {
  if (g.status === 'unreachable') {
    return 'Unreachable: no tool can act on this line, so it stays advice only';
  }
  if (g.status === 'refused') return 'Refused: this line would grant access, so it is not applied';
  return `Maps to ${g.mapsTo.join(', ') || 'no tool'}`;
}

export function GuidanceRows({ guidance }: { guidance: GuidanceMapping[] }) {
  if (guidance.length === 0) return <span className="initiative-muted">none</span>;
  return (
    <ul className="initiative-guidance">
      {guidance.map((g, i) => (
        // Lines have no id; order is the identity (the server returns one mapping per line).
        // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered lines
        <li key={i} data-guidance-status={g.status}>
          <span>{g.text}</span>
          <span className={`initiative-guidance-note initiative-guidance-${g.status}`}>
            {g.status === 'mapped' ? '✓' : '⚠'} {guidanceNote(g)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Every initiative-file key as its own labeled row (Config surfaces matrix). */
export function FileRows({
  file,
  guidance,
}: {
  file: InitiativeFileWire;
  guidance: GuidanceMapping[];
}) {
  const rows = FILE_ROWS.filter((r) => !r.agentOnly || file.origin === 'agent');
  return (
    <dl className="initiative-rows">
      {rows.map((r) => (
        <div key={r.key} className="initiative-file-row" data-initiative-key={r.key}>
          <dt data-row-label>{r.label}</dt>
          <dd>
            {r.key === 'guidance' ? (
              <GuidanceRows guidance={guidance} />
            ) : (
              r.value(file).map((v) => (
                <div key={v} className="initiative-value">
                  {v}
                </div>
              ))
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
