import type { ShareSnapshotWire } from '@ethosagent/web-contracts';

// The redacted transcript the reader will see (plan share-links D15). Text is
// rendered as React text nodes, never as HTML. `[REDACTED:<tag>]` markers get
// the redaction chip from the mockup.

const REDACTION = /(\[REDACTED:[A-Za-z0-9_-]+\])/;

interface Segment {
  key: string;
  text: string;
  redacted: boolean;
}

function segments(turn: number, text: string): Segment[] {
  let offset = 0;
  return text.split(REDACTION).map((part, i) => {
    const seg = { key: `${turn}-${offset}`, text: part, redacted: i % 2 === 1 };
    offset += part.length + 1;
    return seg;
  });
}

export function SharePreview({ snapshot }: { snapshot: ShareSnapshotWire }) {
  return (
    // A scrollable region must take focus so the keyboard can scroll it.
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scroll of the overflow box
    <section className="share-preview" tabIndex={0} aria-label="Redacted transcript preview">
      {snapshot.turns.map((turn, ti) => (
        // Turns have no id; the list is a frozen snapshot, so position is stable.
        // biome-ignore lint/suspicious/noArrayIndexKey: frozen snapshot, order never changes
        <div className="share-turn" key={ti}>
          <div className="share-role">
            {turn.role === 'user' ? 'You' : (snapshot.personalityId ?? 'assistant')}
          </div>
          <p className="share-txt">
            {segments(ti, turn.text).map((s) =>
              s.redacted ? (
                <span className="share-red" key={s.key}>
                  {s.text}
                </span>
              ) : (
                s.text
              ),
            )}
          </p>
          {turn.tools && turn.tools.length > 0 ? (
            <div className="share-chips">
              {turn.tools.map((t, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the same tool can run twice
                <span className={`share-chip${t.isError ? ' share-chip-err' : ''}`} key={i}>
                  {t.isError ? '✗ ' : ''}
                  {t.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
