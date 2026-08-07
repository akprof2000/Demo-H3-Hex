import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
// 🕸️ Компонент «сетка на весь экран»: покрывает видимую область карты
// границами гексагонов H3 заданного разрешения. Данных нет — только сетка.
//
// Читать сверху вниз: блоки пронумерованы 1️⃣…6️⃣ в порядке работы.
import maplibregl, { Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import { latLngToCell } from 'h3-js';
import { H3GridLayer } from './H3GridLayer';
import { osmStyle } from './mapStyle';
import {
  buildGridMesh,
  cellsForBBox,
  estimateCellCount,
  padBBox,
  resolutionForEdgePixels,
  type BBox,
} from './gridGeometry';

/** 📊 Что происходит с сеткой прямо сейчас — уходит в колбэк `onGrid`. */
export interface GridInfo {
  /** 📏 Разрешение H3, на котором построена сетка. */
  resolution: number;
  /** 🧱 Сколько ячеек попало на экран. */
  cells: number;
  /** ⏱️ Сколько миллисекунд заняло построение. */
  ms: number;
  /**
   * 🛑 true, если построение отменено: ячеек на экране было бы больше `maxCells`.
   * Разумная реакция интерфейса — попросить пользователя приблизить карту.
   */
  overflow: boolean;
}

export interface H3GridProps {
  /**
   * 📏 Разрешение H3 (0…15) или `'auto'`.
   *
   * `'auto'` подбирает разрешение так, чтобы ребро гексагона занимало примерно
   * `targetEdgePixels` пикселей — сетка выглядит одинаково на любом зуме.
   */
  resolution?: number | 'auto';
  /** 🎯 Желаемый размер ребра в пикселях для режима `'auto'`. По умолчанию 40. */
  targetEdgePixels?: number;

  /**
   * 🛡️ Предохранитель: выше этого числа ячеек сетка не строится.
   *
   * На разрешении 12 в масштабе города ячеек десятки миллионов — без этого
   * ограничения вкладка просто повиснет. По умолчанию 60 000.
   */
  maxCells?: number;

  /**
   * 🎨 Цвет линий: CSS-строка ("#fff", "rgba(...)") или [r,g,b,a] в 0..1.
   * По умолчанию чёрный с альфой 0.45 — он лучше всего читается на тайлах OSM.
   */
  color?: string | [number, number, number, number];
  /**
   * 📏 Толщина линий сетки в CSS-пикселях. По умолчанию 2.
   *
   * Толщина считается на GPU, поэтому её смена не перестраивает геометрию —
   * это ровно один кадр независимо от числа гексагонов.
   */
  lineWidth?: number;
  /** ✨ Цвет контура ячейки под курсором. Формат тот же. */
  highlightColor?: string | [number, number, number, number];
  /** 📏 Толщина контура выделения. По умолчанию на пиксель толще сетки. */
  highlightWidth?: number;
  /** 🖱️ false — не подсвечивать ячейку под курсором. По умолчанию подсвечивать. */
  highlight?: boolean;

  /** ⏱️ Задержка пересчёта после движения карты, мс. По умолчанию 120. */
  debounceMs?: number;

  center?: [lng: number, lat: number];
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  /** 🗺️ Стиль подложки. По умолчанию — растровый OpenStreetMap. */
  mapStyle?: string | StyleSpecification;

  /** 👆 Индекс ячейки под курсором (null — курсор ушёл с карты). */
  onHover?: (h3: string | null) => void;
  /** 🖱️ Индекс ячейки, по которой кликнули. */
  onClick?: (h3: string) => void;
  /** 📊 Статистика после каждой пересборки сетки. */
  onGrid?: (info: GridInfo) => void;

  /** 💬 false — выключить встроенную подсказку с индексом ячейки. */
  tooltip?: false | ((h3: string) => ReactNode);

  className?: string;
  style?: CSSProperties;
  /** 🧩 Своя панель управления поверх карты. */
  children?: ReactNode;
}

const wrap: CSSProperties = { position: 'relative', width: '100%', height: '100%' };
const tipStyle: CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none', // 🚫 подсказка не должна перехватывать мышь у карты
  transform: 'translate(12px, 12px)',
  padding: '5px 8px',
  borderRadius: 5,
  background: 'rgba(20,22,28,0.9)',
  color: '#e8eaed',
  font: '12px/1.35 ui-monospace, monospace',
  whiteSpace: 'nowrap',
  zIndex: 2,
};

/**
 * 🎨 Цвет в формат GL: четыре числа 0..1.
 *
 * WebGL не понимает "#rrggbb", поэтому строку разбираем сами. Массив пропускаем
 * как есть — считаем, что он уже в нужном диапазоне.
 */
function toGlColor(
  c: string | [number, number, number, number] | undefined,
  fallback: [number, number, number, number]
): [number, number, number, number] {
  if (!c) return fallback;
  if (typeof c !== 'string') return c;
  let h = c.trim();
  if (h[0] === '#') {
    h = h.slice(1);
    // 🔁 Короткая форма "#abc" → "aabbcc"
    if (h.length === 3 || h.length === 4) h = h.replace(/./g, (ch) => ch + ch);
    const n = parseInt(h.slice(0, 8), 16);
    if (h.length >= 8) {
      // 🧮 Побитово достаём каналы и нормируем 0..255 → 0..1
      return [((n >>> 24) & 255) / 255, ((n >>> 16) & 255) / 255, ((n >>> 8) & 255) / 255, (n & 255) / 255];
    }
    return [((n >>> 16) & 255) / 255, ((n >>> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  // 🧵 "rgb(...)" / "rgba(...)": вытаскиваем числа регуляркой
  const m = h.match(/[\d.]+/g);
  if (m && m.length >= 3) {
    return [+m[0] / 255, +m[1] / 255, +m[2] / 255, m.length > 3 ? +m[3] : 1];
  }
  return fallback; // 🤷 не разобрали — берём цвет по умолчанию
}

export function H3Grid({
  resolution = 'auto',
  targetEdgePixels = 40,
  maxCells = 60_000,
  color,
  lineWidth = 2,
  highlightColor,
  highlightWidth,
  highlight = true,
  debounceMs = 120,
  center = [37.6173, 55.7558],
  zoom = 11,
  minZoom,
  maxZoom,
  mapStyle,
  onHover,
  onClick,
  onGrid,
  tooltip,
  className,
  style,
  children,
}: H3GridProps) {
  const container = useRef<HTMLDivElement>(null); // 📦 div, куда MapLibre вставит canvas
  const layerRef = useRef<H3GridLayer | null>(null); // 🕸️ GPU-слой (живёт вне рендера React)
  const [map, setMap] = useState<MlMap | null>(null);
  const [ready, setReady] = useState(false); // ✅ карта загружена и слой добавлен
  const [hover, setHover] = useState<{ h3: string; x: number; y: number } | null>(null);

  // 📌 Свежие ссылки на колбэки без переподписки на события карты:
  // если класть onGrid прямо в зависимости эффекта, каждая новая стрелка
  // в родителе будет отписывать и переподписывать обработчики. ♻️
  const onGridRef = useRef(onGrid);
  onGridRef.current = onGrid;

  // 1️⃣ Создание карты — ровно один раз за жизнь компонента
  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: mapStyle ?? osmStyle(), // 🗺️ по умолчанию — OpenStreetMap
      center,
      zoom,
      minZoom,
      maxZoom,
      attributionControl: { compact: true },
    });
    const layer = new H3GridLayer();
    layerRef.current = layer;
    // ⏳ Слой добавляем только после load: раньше у карты ещё нет стиля
    m.on('load', () => {
      m.addLayer(layer);
      setReady(true);
    });
    setMap(m);
    return () => {
      setReady(false);
      layerRef.current = null;
      m.remove(); // 🧹 иначе утечёт WebGL-контекст (а их у браузера штук 16)
    };
    // ⚠️ Осознанно пустые зависимости: пересоздавать карту на каждый проп дорого.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2️⃣ Цвета: переводим в формат GL и отдаём слою без перестроения геометрии
  // ⚫ Значение по умолчанию продублировано со слоем осознанно: слой умеет жить
  // без компонента, а компонент — без слоя (до его создания), и оба должны
  // показывать одно и то же.
  const glColor = useMemo(() => toGlColor(color, [0, 0, 0, 0.45]), [color]);
  const glHighlight = useMemo(() => toGlColor(highlightColor, [1, 0.85, 0.2, 1]), [highlightColor]);
  useEffect(() => {
    layerRef.current?.setColor(glColor);
  }, [glColor, ready]);

  // 3️⃣ Разрешение, действующее прямо сейчас. В режиме 'auto' оно зависит от
  // зума, поэтому пересчитывается при каждом движении карты. 🔁
  const currentResolution = useCallback(
    (m: MlMap): number => {
      if (resolution !== 'auto') return Math.max(0, Math.min(15, Math.round(resolution)));
      return resolutionForEdgePixels(m.getZoom(), m.getCenter().lat, targetEdgePixels);
    },
    [resolution, targetEdgePixels]
  );

  /**
   * 4️⃣ Пересборка сетки под текущий вид.
   *
   * Порядок важен: сначала дешёвая ОЦЕНКА числа ячеек и только потом реальное
   * построение. Иначе на мелком разрешении `polygonToCells` подвесит вкладку
   * задолго до того, как мы успеем что-то проверить. 🛡️
   */
  const rebuild = useCallback(
    (m: MlMap) => {
      const layer = layerRef.current;
      if (!layer) return;
      const t0 = performance.now();
      const res = currentResolution(m);

      const b = m.getBounds();
      // 🖼️ Видимая область + запас по краям, чтобы сетка не обрывалась «зубцами»
      const bbox = padBBox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] as BBox);

      // 🛡️ Предохранитель: слишком мелкая сетка на слишком большой области
      if (estimateCellCount(bbox, res) > maxCells) {
        layer.setMesh(buildGridMesh([], res)); // 🕳️ показываем пустоту, а не виснем
        onGridRef.current?.({ resolution: res, cells: 0, ms: 0, overflow: true });
        return;
      }

      const cells = cellsForBBox(bbox, res); // 🧱 какие ячейки накрывают экран
      const mesh = buildGridMesh(cells, res); // ➖ и их границы одним буфером
      layer.setMesh(mesh);
      onGridRef.current?.({
        resolution: res,
        cells: cells.length,
        ms: Math.round(performance.now() - t0),
        overflow: false,
      });
    },
    [currentResolution, maxCells]
  );

  // 5️⃣ Пересчёт сетки: сразу при готовности и далее на каждое движение карты.
  // Дебаунс нужен, потому что moveend прилетает и в конце инерции прокрутки. ⏱️
  useEffect(() => {
    if (!map || !ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => rebuild(map), debounceMs);
    };
    rebuild(map); // 🚀 первый расчёт — без задержки
    map.on('moveend', schedule);
    map.on('zoomend', schedule);
    return () => {
      clearTimeout(timer);
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
    };
  }, [map, ready, rebuild, debounceMs]);

  // 6️⃣ Мышь: наведение, подсветка, клик.
  //
  // 🎯 Никакого пикинга через отрисовку в offscreen-буфер: индекс ячейки
  // считается прямо из координат курсора функцией latLngToCell. Это O(1). ⚡
  useEffect(() => {
    if (!map || !ready) return;
    const cellAt = (lng: number, lat: number) => latLngToCell(lat, lng, currentResolution(map));

    const onMove = (e: maplibregl.MapMouseEvent) => {
      const h3 = cellAt(e.lngLat.lng, e.lngLat.lat);
      // ♻️ Тот же гексагон и та же точка — сохраняем прежний объект, чтобы React
      // не перерисовывал подсказку на каждое микродвижение мыши.
      setHover((prev) =>
        prev?.h3 === h3 && prev?.x === e.point.x ? prev : { h3, x: e.point.x, y: e.point.y }
      );
      if (highlight) layerRef.current?.setHighlight(h3);
      onHover?.(h3);
    };
    const onLeave = () => {
      setHover(null);
      layerRef.current?.setHighlight(null);
      onHover?.(null);
    };
    const onTap = (e: maplibregl.MapMouseEvent) => {
      const h3 = cellAt(e.lngLat.lng, e.lngLat.lat);
      // 📱 На тач-устройствах mousemove не бывает — показываем подсказку по тапу
      setHover({ h3, x: e.point.x, y: e.point.y });
      if (highlight) layerRef.current?.setHighlight(h3);
      onClick?.(h3);
    };

    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    map.on('click', onTap);
    return () => {
      map.off('mousemove', onMove);
      map.off('mouseout', onLeave);
      map.off('click', onTap);
    };
  }, [map, ready, currentResolution, highlight, onHover, onClick]);

  // ✨ Цвет подсветки — тоже без перестроения геометрии
  useEffect(() => {
    layerRef.current?.setHighlightColor(glHighlight);
  }, [glHighlight, ready]);

  // 📏 Толщина линий: живёт в uniform, поэтому меняется мгновенно
  useEffect(() => {
    layerRef.current?.setWidth(lineWidth, highlightWidth ?? lineWidth + 1);
  }, [lineWidth, highlightWidth, ready]);

  // 🖼️ Разметка: canvas карты + слои интерфейса поверх него
  return (
    <div className={className} style={{ ...wrap, ...style }}>
      {/* 🗺️ Сюда MapLibre вставит свой canvas */}
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      {/* 💬 Подсказка — обычный HTML поверх карты, а не отрисовка в GL */}
      {tooltip !== false && hover && (
        <div style={{ ...tipStyle, left: hover.x, top: hover.y }}>
          {tooltip ? tooltip(hover.h3) : hover.h3}
        </div>
      )}
      {/* 🧩 Своя панель управления и что угодно ещё */}
      {children}
    </div>
  );
}
