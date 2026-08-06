import type { CSSProperties } from 'react';
import type { ColorScale } from './palette';

export interface LegendProps {
  scale: ColorScale;
  title?: string;
  format?: (v: number) => string;
  style?: CSSProperties;
}

const box: CSSProperties = {
  position: 'absolute',
  right: 10,
  bottom: 28,
  padding: '8px 10px',
  borderRadius: 6,
  background: 'rgba(20,22,28,0.82)',
  color: '#e8eaed',
  font: '12px/1.3 system-ui, sans-serif',
  pointerEvents: 'none',
};

export function Legend({ scale, title, format, style }: LegendProps) {
  const fmt = format ?? ((v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2)));
  const stops: string[] = [];
  for (let i = 0; i <= 10; i++) {
    stops.push(scale.css(scale.min + ((scale.max - scale.min) * i) / 10));
  }
  return (
    <div style={{ ...box, ...style }}>
      {title && <div style={{ marginBottom: 4, opacity: 0.85 }}>{title}</div>}
      <div
        style={{
          width: 140,
          height: 10,
          borderRadius: 2,
          background: `linear-gradient(to right, ${stops.join(',')})`,
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, opacity: 0.8 }}>
        <span>{fmt(scale.min)}</span>
        <span>{fmt(scale.max)}</span>
      </div>
    </div>
  );
}
