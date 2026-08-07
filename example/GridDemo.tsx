import { useState } from 'react';
// 🕸️ Демо компонента `H3Grid`: сетка гексагонов H3 поверх OpenStreetMap.
// Данных здесь нет вообще — только границы ячеек, которыми закрашен весь экран.
import { H3Grid, type GridInfo } from 'react-h3-map';

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  left: 10,
  zIndex: 3,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(20,22,28,0.85)',
  color: '#e8eaed',
  font: '13px/1.6 system-ui, sans-serif',
  minWidth: 250,
};

const select: React.CSSProperties = {
  background: '#1b1f27',
  color: '#e8eaed',
  border: '1px solid #333',
  borderRadius: 4,
  padding: '2px 4px',
};

// 🎨 Готовые цвета сетки. Альфа задаётся прямо в hex — последние два символа.
// Чёрная стоит первой и выбрана по умолчанию: на растровых тайлах OSM тёмная
// линия читается лучше всего.
const COLORS: Record<string, string> = {
  Чёрная: '#00000073',
  Белая: '#ffffff59',
  Бирюзовая: '#22d3eeaa',
  Янтарная: '#f59e0baa',
  Красная: '#ef4444aa',
};

export default function GridDemo() {
  // 📏 'auto' — разрешение подбирается по зуму, число — фиксированное разрешение
  const [res, setRes] = useState<number | 'auto'>('auto');
  // 🎯 Желаемый размер ребра гексагона на экране (только для режима 'auto')
  const [target, setTarget] = useState(40);
  const [colorName, setColorName] = useState<keyof typeof COLORS>('Чёрная');
  // 📊 Статистика последней пересборки сетки
  const [info, setInfo] = useState<GridInfo | null>(null);
  // 🖱️ Индекс ячейки, по которой кликнули
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <H3Grid
      resolution={res}
      targetEdgePixels={target}
      color={COLORS[colorName]}
      center={[37.6173, 55.7558]} // 🏙️ Москва, Кремль
      zoom={11}
      minZoom={3}
      maxZoom={18}
      onGrid={setInfo} // 📊 после каждой пересборки
      onClick={setPicked}
      tooltip={(h3) => <span>{h3}</span>}
    >
      <div style={panel}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>H3Grid · сетка на весь экран</div>

        {/* 📏 Выбор разрешения: авто или фиксированное */}
        <label style={{ display: 'block' }}>
          Разрешение{' '}
          <select
            value={String(res)}
            onChange={(e) => setRes(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
            style={select}
          >
            <option value="auto">авто (по зуму)</option>
            {/* 🔢 Разрешения 4…12: от области размером с страну до квартала */}
            {[4, 5, 6, 7, 8, 9, 10, 11, 12].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        {/* 🎯 Ползунок цели по размеру ребра — работает только в режиме 'auto' */}
        {res === 'auto' && (
          <label style={{ display: 'block' }}>
            Ребро ≈ {target} px
            <input
              type="range"
              min={12}
              max={120}
              step={4}
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>
        )}

        {/* 🎨 Цвет линий сетки */}
        <label style={{ display: 'block' }}>
          Цвет{' '}
          <select
            value={colorName}
            onChange={(e) => setColorName(e.target.value as keyof typeof COLORS)}
            style={select}
          >
            {Object.keys(COLORS).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>

        <div style={{ marginTop: 6 }}>
          Разрешение сетки: <b>{info?.resolution ?? '—'}</b>
        </div>
        <div>
          Гексагонов на экране: <b>{(info?.cells ?? 0).toLocaleString('ru')}</b>
        </div>
        <div>
          Построение: <b>{info?.ms ?? 0} мс</b>
        </div>
        {/* 🛑 Предохранитель сработал: ячеек было бы слишком много */}
        {info?.overflow && (
          <div style={{ color: '#f59e0b' }}>Слишком мелко для этого масштаба — приблизьте карту</div>
        )}
        <div style={{ marginTop: 6, opacity: 0.75 }}>
          {picked ? `Клик: ${picked}` : 'Кликните по гексагону'}
        </div>
      </div>
    </H3Grid>
  );
}
