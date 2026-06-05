import { useState } from 'react';

interface BatchResult {
  input: string;
  output: string;
  expected?: string;
  score?: number;
  passed: boolean;
}

interface BatchResultsTableProps {
  results: BatchResult[];
  showExpected?: boolean;
  showScore?: boolean;
}

function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

const headerStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-tertiary)',
  textAlign: 'left',
  padding: '0 8px',
};

const cellStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--text-secondary)',
  padding: '0 8px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: 200,
};

export function BatchResultsTable({ results, showExpected, showScore }: BatchResultsTableProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const passedCount = results.filter((r) => r.passed).length;
  const passRate = results.length > 0 ? ((passedCount / results.length) * 100).toFixed(1) : '0.0';
  const scores = results.map((r) => r.score).filter((s): s is number => s != null);
  const avgScore =
    scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : null;

  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-tertiary)',
          marginBottom: 8,
        }}
      >
        Results
      </div>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr style={{ height: 32, background: 'var(--bg-elevated)' }}>
            <th style={{ ...headerStyle, width: 36 }}>#</th>
            <th style={headerStyle}>Input</th>
            {showExpected && <th style={headerStyle}>Expected</th>}
            <th style={headerStyle}>Output</th>
            {showScore && <th style={{ ...headerStyle, width: 70 }}>Score</th>}
            <th style={{ ...headerStyle, width: 60 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, idx) => {
            const rowKey = `${r.input.slice(0, 30)}-${r.output.slice(0, 30)}-${r.passed}`;
            return (
              <>
                <tr
                  key={`row-${rowKey}`}
                  onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                  style={{
                    minHeight: 44,
                    borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    transition: 'background-color var(--motion-fast) var(--ease)',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'var(--ethos-hover)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }}
                >
                  <td style={{ ...cellStyle, width: 36 }}>{idx + 1}</td>
                  <td style={cellStyle} title={r.input}>
                    {truncate(r.input)}
                  </td>
                  {showExpected && (
                    <td style={cellStyle} title={r.expected}>
                      {truncate(r.expected ?? '')}
                    </td>
                  )}
                  <td style={cellStyle} title={r.output}>
                    {truncate(r.output)}
                  </td>
                  {showScore && (
                    <td style={cellStyle}>{r.score != null ? r.score.toFixed(2) : '-'}</td>
                  )}
                  <td style={{ ...cellStyle, width: 60 }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '2px 6px',
                        borderRadius: 'var(--radius-sm)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        fontWeight: 500,
                        lineHeight: 1.4,
                        letterSpacing: '0.02em',
                        background: r.passed
                          ? 'rgba(74, 222, 128, 0.15)'
                          : 'rgba(248, 113, 113, 0.15)',
                        color: r.passed ? 'var(--green)' : 'var(--red)',
                      }}
                    >
                      {r.passed ? 'ok' : 'error'}
                    </span>
                  </td>
                </tr>
                {expandedIdx === idx && (
                  <tr key={`expanded-${rowKey}`}>
                    <td
                      colSpan={showExpected && showScore ? 6 : showExpected || showScore ? 5 : 4}
                      style={{
                        padding: '8px 16px 12px',
                        background: 'var(--bg-elevated)',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div>
                          <span style={{ ...headerStyle, padding: 0 }}>Input</span>
                          <pre
                            style={{
                              margin: '4px 0 0',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              color: 'var(--text-primary)',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {r.input}
                          </pre>
                        </div>
                        <div>
                          <span style={{ ...headerStyle, padding: 0 }}>Output</span>
                          <pre
                            style={{
                              margin: '4px 0 0',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              color: 'var(--text-primary)',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {r.output}
                          </pre>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          marginTop: 8,
          padding: '0 8px',
        }}
      >
        {passedCount}/{results.length} passed &middot; {passRate}% pass rate
        {avgScore != null && <> &middot; avg score {avgScore}</>}
      </div>
    </div>
  );
}
