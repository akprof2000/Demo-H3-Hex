// 🌈 Легенда палитры: градиент для непрерывной шкалы, список диапазонов —
// для дискретной (с долей ячеек в каждом диапазоне, как в отраслевых ГИС). 📊
import { useMemo, type CSSProperties } from 'react';
import type { ColorScale } from './palette';
import type { H3Cell } from './types';

export interface LegendProps {
  scale: ColorScale;
  title?: string;
  format?: (v: number) => string;
  /** 📊 Данные — нужны, чтобы посчитать долю ячеек в каждом диапазоне. */
  cells?: readonly H3Cell[];
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
  pointerEvents: 'none', // 🖱️ легенда не должна перехватывать мышь у карты
};

/** 🎨 Квадратик цвета в списке диапазонов. */
const swatch = (color: string): CSSProperties => ({
  width: 14,
  height: 14,
  borderRadius: 2,
  background: color,
  flex: '0 0 auto',
});

export function Legend({ scale, title, format, cells, style }: LegendProps) {
  const fmt = format ?? ((v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2)));

  // 📊 Доли по диапазонам: один проход по данным, пересчёт только при их смене
  const shares = useMemo(() => {
    if (!scale.bins || !cells || cells.length === 0) return null;
    const counts = new Array(scale.bins.length).fill(0);
    let outside = 0;
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i][1];
      const idx = scale.bins.findIndex((b) => v >= b.from && v < b.to);
      if (idx >= 0) counts[idx]++;
      else outside++; // ⬜ «без значения»
    }
    return { counts, outside, total: cells.length };
  }, [scale, cells]);

  // 🪜 Дискретная шкала — список диапазонов
  if (scale.bins) {
    return (
      <div style={{ ...box, ...style }}>
        {title && <div style={{ marginBottom: 5, opacity: 0.85 }}>{title}</div>}
        {shares && (
          <div style={{ textAlign: 'right', opacity: 0.6, marginBottom: 3 }}>
            {shares.total.toLocaleString('ru')} шт.
          </div>
        )}
        {scale.bins.map((b, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <div style={swatch(scale.css((b.from + b.to) / 2))} />
            <span style={{ flex: 1 }}>{b.label ?? `${fmt(b.from)} … ${fmt(b.to)}`}</span>
            {shares && (
              <span style={{ opacity: 0.75, minWidth: 48, textAlign: 'right' }}>
                {((shares.counts[i] / shares.total) * 100).toFixed(2)} %
              </span>
            )}
          </div>
        ))}
        {shares && shares.outside > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, opacity: 0.7 }}>
            <div style={swatch('rgba(128,128,128,0.8)')} />
            <span style={{ flex: 1 }}>без значения</span>
            <span style={{ minWidth: 48, textAlign: 'right' }}>
              {((shares.outside / shares.total) * 100).toFixed(2)} %
            </span>
          </div>
        )}
      </div>
    );
  }

  // 🌈 Непрерывная шкала — градиентная полоска из 11 контрольных точек
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
