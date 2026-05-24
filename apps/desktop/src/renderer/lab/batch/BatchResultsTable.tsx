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
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-tertiary)',
  textAlign: 'left',
  padding: '0 8px',
};

const cellStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  padding: '0 8px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: 200,
};

export function BatchResultsTable({ results, showExpected, showScore }: BatchResultsTableProps) {
  const passedCount = results.filter((r) => r.passed).length;
  const passRate = results.length > 0 ? ((passedCount / results.length) * 100).toFixed(1) : '0.0';
  const scores = results.map((r) => r.score).filter((s): s is number => s != null);
  const avgScore =
    scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : null;

  return (
    <div>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr style={{ height: 32 }}>
            <th style={headerStyle}>Input</th>
            {showExpected && <th style={headerStyle}>Expected</th>}
            <th style={headerStyle}>Actual Output</th>
            {showScore && <th style={{ ...headerStyle, width: 70 }}>Score</th>}
            <th style={{ ...headerStyle, width: 60 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr
              key={`${r.input.slice(0, 40)}-${r.output.slice(0, 40)}`}
              style={{
                minHeight: 44,
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
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
                <td
                  style={{
                    ...cellStyle,
                    fontFamily: 'var(--font-mono)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {r.score != null ? r.score.toFixed(2) : '-'}
                </td>
              )}
              <td
                style={{
                  ...cellStyle,
                  fontSize: 14,
                  color: r.passed ? 'var(--success)' : 'var(--error)',
                }}
              >
                {r.passed ? '✓' : '✗'}
              </td>
            </tr>
          ))}
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
