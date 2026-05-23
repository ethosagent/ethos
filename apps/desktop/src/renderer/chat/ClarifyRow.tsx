import { useCallback, useState } from 'react';

interface ClarifyRowProps {
  requestId: string;
  question: string;
  options?: string[];
  defaultAnswer?: string;
  onRespond: (requestId: string, answer: string) => void;
}

export function ClarifyRow({
  requestId,
  question,
  options,
  defaultAnswer,
  onRespond,
}: ClarifyRowProps) {
  const [input, setInput] = useState(defaultAnswer ?? '');

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed) {
      onRespond(requestId, trimmed);
    }
  }, [input, onRespond, requestId]);

  const handleOptionClick = useCallback(
    (option: string) => {
      onRespond(requestId, option);
    },
    [onRespond, requestId],
  );

  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-md)',
        padding: 12,
        margin: '8px 0',
      }}
    >
      <div
        style={{
          fontSize: 14,
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-display)',
          marginBottom: 10,
          lineHeight: 1.5,
        }}
      >
        {question}
      </div>
      {options && options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => handleOptionClick(opt)}
              style={{
                height: 28,
                padding: '0 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-overlay)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-subtle)',
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Type your answer..."
          style={{
            flex: 1,
            height: 36,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-overlay)',
            border: '1px solid var(--border-subtle)',
            padding: '0 12px',
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={handleSubmit}
          style={{
            height: 36,
            padding: '0 14px',
            background: 'transparent',
            color: 'var(--accent)',
            border: 'none',
            fontFamily: 'var(--font-display)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Answer
        </button>
      </div>
    </div>
  );
}
