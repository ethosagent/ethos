interface SliderRowProps {
  label: string;
  subText?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}

export function SliderRow({
  label,
  subText,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: SliderRowProps) {
  return (
    <div
      style={{
        padding: '8px 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <style>{`
        .ethos-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          margin-top: 8px;
          background: transparent;
        }
        .ethos-slider::-webkit-slider-runnable-track {
          height: 4px;
          background: var(--bg-overlay);
          border-radius: 2px;
          border: none;
        }
        .ethos-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--text-primary);
          border: none;
          cursor: pointer;
          margin-top: -5px;
        }
        .ethos-slider::-moz-range-track {
          height: 4px;
          background: var(--bg-overlay);
          border-radius: 2px;
          border: none;
        }
        .ethos-slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--text-primary);
          border: none;
          cursor: pointer;
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 24 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 400,
              color: 'var(--text-primary)',
            }}
          >
            {label}
          </div>
          {subText && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                marginTop: 2,
              }}
            >
              {subText}
            </div>
          )}
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-tertiary)',
            marginLeft: 16,
            flexShrink: 0,
          }}
        >
          {value}
          {unit || ''}
        </span>
      </div>
      <input
        type="range"
        className="ethos-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
