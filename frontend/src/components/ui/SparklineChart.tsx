interface Series {
  key: string;
  color: string;
  values: number[];
}

interface SparklineChartProps {
  labels: string[];
  series: Series[];
  height?: number;
}

/** Hand-rolled SVG line chart — dense telemetry style, no external chart library. */
export function SparklineChart({ labels, series, height = 160 }: SparklineChartProps) {
  const width = 100;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const min = Math.min(0, ...series.flatMap((s) => s.values));
  const range = max - min || 1;
  const stepX = width / Math.max(1, labels.length - 1);

  const toPoints = (values: number[]) =>
    values
      .map((v, i) => {
        const x = i * stepX;
        const y = height - ((v - min) / range) * height;
        return `${x},${y}`;
      })
      .join(" ");

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="#273244" strokeWidth="0.5" />
        {series.map((s) => (
          <polyline
            key={s.key}
            points={toPoints(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="flex justify-between font-code-dense text-code-dense text-outline mt-1">
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </div>
  );
}
