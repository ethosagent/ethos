import { useMemo } from 'react';

interface SparklineChartProps {
  data: number[];
  width: number;
  height: number;
  strokeColor?: string;
  labels?: string[];
}

export function SparklineChart({
  data,
  width,
  height,
  strokeColor = 'var(--info)',
  labels,
}: SparklineChartProps) {
  const padding = 12;
  const labelHeight = 16;
  const yLabelWidth = 32;

  const { min, max, points, polylinePoints } = useMemo(() => {
    if (data.length === 0) return { min: 0, max: 0, points: [], polylinePoints: '' };

    const mn = Math.min(...data);
    const mx = Math.max(...data);
    const range = mx - mn || 1;
    const plotW = width - yLabelWidth;
    const plotH = height - labelHeight;

    const pts = data.map((v, i) => ({
      x: yLabelWidth + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2),
      y: plotH - ((v - mn) / range) * plotH,
    }));

    return {
      min: mn,
      max: mx,
      points: pts,
      polylinePoints: pts.map((p) => `${p.x},${p.y}`).join(' '),
    };
  }, [data, width, height]);

  const svgHeight = height - labelHeight;

  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        borderRadius: 8,
        padding,
        border: '1px solid var(--border-subtle)',
        display: 'inline-block',
      }}
    >
      <div style={{ position: 'relative' }}>
        <svg
          width={width}
          height={svgHeight}
          style={{ display: 'block' }}
          aria-label="Sparkline chart"
        >
          <title>Sparkline chart</title>
          {data.length > 0 && (
            <>
              <polyline
                points={polylinePoints}
                fill="none"
                stroke={strokeColor}
                strokeWidth={1.5}
              />
              {points.map((p) => (
                <circle key={`${p.x}-${p.y}`} cx={p.x} cy={p.y} r={3} fill={strokeColor} />
              ))}
            </>
          )}
        </svg>

        <span
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-tertiary)',
          }}
        >
          {max}
        </span>
        <span
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-tertiary)',
          }}
        >
          {min}
        </span>
      </div>

      {labels && labels.length > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 4,
            paddingLeft: yLabelWidth,
          }}
        >
          {labels.map((label) => (
            <span
              key={label}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-tertiary)',
              }}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
