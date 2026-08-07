import { useCallback, useRef, useState } from 'react';
import {
  H3Map,
  RSRP_PALETTE,
  edgeModeForView,
  type EdgeMode,
  type Fetcher,
  type HoverInfo,
  type Palette,
} from 'react-h3-map';
import { DOMAIN, fetchHexes } from './mockBackend';

/** Vite резолвит воркер из исходников; в приложении путь ведёт в dist пакета. */
const workerFactory = () =>
  new Worker(new URL('../src/meshWorker.ts', import.meta.url), { type: 'module' });

const EDGE_LABEL: Record<EdgeMode, string> = {
  all: 'все рёбра',
  boundary: 'границы цветов',
  none: 'без обводки',
};

/**
 * 📏 Демо Москвы: разрешение H3 от 6 (город целиком) до 14 (дом).
 *
 * Шаг разрешения в H3 — это ребро примерно в 2.6 раза меньше и в 7 раз больше
 * ячеек на той же площади. Здесь взят на уровень мельче «интуитивного» `zoom - 3`,
 * чтобы на экран влезало заметно больше гексагонов. 🔍
 */
function moscowResolution(zoom: number): number {
  const r = Math.round(zoom) - 2;
  return r < 6 ? 6 : r > 14 ? 14 : r;
}

const PALETTES: Record<string, Palette> = {
  // 📶 Дискретная шкала RSRP — стандартные пороги радиопланирования
  'RSRP (пороги)': RSRP_PALETTE,
  Инферно: {
    colors: ['#2b0b3f', '#5b1f7a', '#a52f7a', '#e05c4f', '#f7a838', '#f9f871'],
    opacity: 0.78,
  },
  Вириди: {
    colors: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
    opacity: 0.78,
  },
  'Синий → красный': {
    colors: ['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'],
    opacity: 0.72,
  },
};

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  left: 10,
  zIndex: 3,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(20,22,28,0.85)',
  color: '#e8eaed',
  font: '13px/1.5 system-ui, sans-serif',
  minWidth: 220,
};

export default function HeatDemo() {
  const [paletteName, setPaletteName] = useState<keyof typeof PALETTES>('RSRP (пороги)');
  const [stats, setStats] = useState({ cells: 0, res: 0, ms: 0, edges: 'none' as EdgeMode });
  const [picked, setPicked] = useState<HoverInfo | null>(null);
  const t0 = useRef(0);

  const fetcher = useCallback<Fetcher>(async (vp, signal) => {
    t0.current = performance.now();
    const cells = await fetchHexes(vp, signal);
    setStats({
      cells: cells.length,
      res: vp.resolution,
      ms: Math.round(performance.now() - t0.current),
      edges: edgeModeForView(vp.resolution, vp.zoom, 55.7558),
    });
    return { cells, domain: DOMAIN };
  }, []);

  return (
    <H3Map
      fetchData={fetcher}
      resolutionForZoom={moscowResolution}
      center={[37.6173, 55.7558]}
      zoom={10}
      minZoom={9}
      maxZoom={17}
      palette={PALETTES[paletteName]}
      workerThreshold={5000}
      workerFactory={workerFactory}
      legend={{ title: 'Агрегация Best · rsrp', format: (v) => v.toFixed(0) }}
      onClick={setPicked}
      tooltip={(i) => (
        <>
          <div style={{ opacity: 0.65 }}>{i.h3}</div>
          <div style={{ fontSize: 14 }}>{i.value} дБм</div>
        </>
      )}
    >
      <div style={panel}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>react-h3-map · Москва · RSRP</div>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Палитра{' '}
          <select
            value={paletteName}
            onChange={(e) => setPaletteName(e.target.value as keyof typeof PALETTES)}
            style={{ background: '#1b1f27', color: '#e8eaed', border: '1px solid #333', borderRadius: 4 }}
          >
            {Object.keys(PALETTES).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <div>Разрешение H3: <b>{stats.res}</b> (6…14 по зуму)</div>
        <div>Гексагонов: <b>{stats.cells.toLocaleString('ru')}</b></div>
        <div>Загрузка + сборка: <b>{stats.ms} мс</b></div>
        <div>Обводка: <b>{EDGE_LABEL[stats.edges]}</b></div>
        <div style={{ marginTop: 6, opacity: 0.75 }}>
          {picked ? `Клик: ${picked.h3} = ${picked.value} дБм` : 'Кликните по гексагону'}
        </div>
      </div>
    </H3Map>
  );
}
