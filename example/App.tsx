import { useState } from 'react';
// 🧭 Корень демо: переключатель между двумя примерами.
//   • «Тепловая карта» — H3Map: гексагоны с данными и раскраской по RSRP;
//   • «Сетка» — H3Grid: пустая сетка гексагонов на весь экран.
import HeatDemo from './HeatDemo';
import GridDemo from './GridDemo';

const tabs: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 10,
  zIndex: 5, // ⬆️ выше панелей самих демо (у них zIndex 3)
  display: 'flex',
  gap: 4,
  padding: 4,
  borderRadius: 8,
  background: 'rgba(20,22,28,0.85)',
  font: '13px/1.4 system-ui, sans-serif',
};

/** 🎛️ Кнопка вкладки: активная подсвечена, остальные приглушены. */
function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid ' + (active ? '#4b93ff' : '#333'),
    background: active ? '#1d3b6b' : '#1b1f27',
    color: '#e8eaed',
    cursor: 'pointer',
  };
}

export default function App() {
  const [tab, setTab] = useState<'heat' | 'grid'>('grid');

  return (
    // 📐 Обёртка на весь экран: карта внутри тянется на 100% высоты и ширины
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* 🔀 key заставляет React пересоздать компонент при смене вкладки,
          то есть закрыть старую карту и освободить её WebGL-контекст. */}
      {tab === 'grid' ? <GridDemo key="grid" /> : <HeatDemo key="heat" />}

      <div style={tabs}>
        <button style={tabStyle(tab === 'grid')} onClick={() => setTab('grid')}>
          Сетка гексагонов
        </button>
        <button style={tabStyle(tab === 'heat')} onClick={() => setTab('heat')}>
          Тепловая карта
        </button>
      </div>
    </div>
  );
}
