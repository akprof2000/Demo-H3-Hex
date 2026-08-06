import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
// 🧩 Главный компонент: собирает вместе карту, GPU-слой, данные и интерфейс.
// Читать сверху вниз — блоки пронумерованы 1️⃣…8️⃣ в порядке работы.
import maplibregl, { Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import { latLngToCell } from 'h3-js';
import { H3HexLayer } from './H3HexLayer';
import { MeshBuilder } from './meshClient';
import { EDGE_THRESHOLDS, edgeModeForView, type EdgeMode } from './geometry';
import { ColorScale, DEFAULT_PALETTE, domainOf } from './palette';
import { osmStyle } from './mapStyle';
import { Legend } from './Legend';
import { useViewportData, resolutionForZoom, type Fetcher } from './viewport';
import type { H3Cell, HoverInfo, Palette } from './types';

export interface H3MapProps {
  /** Готовый массив [[h3, value], ...]. Взаимоисключим с `fetchData`. */
  data?: readonly H3Cell[];
  /** Подгрузка по вьюпорту: вызывается при moveend/zoomend с дебаунсом. */
  fetchData?: Fetcher;
  debounceMs?: number;
  resolutionForZoom?: (zoom: number) => number;

  palette?: Palette;
  /**
   * Фиксированный диапазон значений. Приоритет: этот проп → `domain` из ответа
   * `fetchData` → min/max по текущим данным.
   */
  domain?: [number, number];

  /**
   * Обводка гексагонов. По умолчанию адаптивная: крупные гексы — полная сетка,
   * средние — только границы между цветами, мелкие — без обводки.
   */
  stroke?:
    | false
    | {
        color?: [number, number, number, number];
        /** Пороги в пикселях на ребро гексагона. */
        thresholds?: { all: number; boundary: number };
        /** Жёстко зафиксировать режим вместо адаптивного выбора. */
        mode?: EdgeMode;
      };

  /** Порог, выше которого меш строится в Web Worker. По умолчанию 20 000. */
  workerThreshold?: number;
  /** Своя фабрика воркера — для сборок, где путь к нему не резолвится сам. */
  workerFactory?: () => Worker;

  center?: [lng: number, lat: number];
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  mapStyle?: string | StyleSpecification;

  onHover?: (info: HoverInfo | null) => void;
  onClick?: (info: HoverInfo | null) => void;
  /** false — выключить встроенный тултип; функция — свой рендер. */
  tooltip?: false | ((info: HoverInfo) => ReactNode);
  legend?: false | { title?: string; format?: (v: number) => string };

  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const wrap: CSSProperties = { position: 'relative', width: '100%', height: '100%' };
const tipStyle: CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
  transform: 'translate(12px, 12px)',
  padding: '5px 8px',
  borderRadius: 5,
  background: 'rgba(20,22,28,0.9)',
  color: '#e8eaed',
  font: '12px/1.35 ui-monospace, monospace',
  whiteSpace: 'nowrap',
  zIndex: 2,
};

export function H3Map({
  data,
  fetchData,
  debounceMs,
  resolutionForZoom: resFn = resolutionForZoom,
  palette = DEFAULT_PALETTE,
  domain,
  stroke = {},
  workerThreshold = 20_000,
  workerFactory,
  center = [37.62, 55.75],
  zoom = 10,
  minZoom,
  maxZoom,
  mapStyle,
  onHover,
  onClick,
  tooltip,
  legend = {},
  className,
  style,
  children,
}: H3MapProps) {
  const container = useRef<HTMLDivElement>(null); // 📦 div, в который MapLibre встроит canvas
  const layerRef = useRef<H3HexLayer | null>(null); // 🖼️ наш GPU-слой (живёт вне рендера React)
  const [map, setMap] = useState<MlMap | null>(null); // 🗺️ экземпляр карты
  const [ready, setReady] = useState(false); // ✅ карта загружена и слой добавлен
  const [hover, setHover] = useState<HoverInfo | null>(null); // 👆 что сейчас под курсором

  // 1️⃣ Создание карты. Ровно один раз за жизнь компонента — пересоздавать её
  // на каждый проп очень дорого, поэтому массив зависимостей пуст.
  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: mapStyle ?? osmStyle(),
      center,
      zoom,
      minZoom,
      maxZoom,
      attributionControl: { compact: true },
    });
    const layer = new H3HexLayer();
    layerRef.current = layer;
    // ⏳ Слой можно добавлять только после события load, иначе стиля ещё нет
    m.on('load', () => {
      m.addLayer(layer);
      setReady(true);
    });
    setMap(m);
    return () => {
      setReady(false);
      layerRef.current = null;
      m.remove(); // 🧹 обязательно, иначе утечёт WebGL-контекст
    };
    // ⚠️ Осознанно пустые зависимости; смена стиля делается через map.setStyle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2️⃣ Данные: либо приходят пропом, либо подгружаются по вьюпорту
  const fetched = useViewportData(map, data ? undefined : fetchData, {
    debounceMs,
    resolutionForZoom: resFn,
  });
  const cells = data ?? fetched.data ?? []; // 📊 актуальный массив ячеек

  // 3️⃣ Диапазон значений: проп → ответ бэкенда → min/max по данным
  const activeDomain = useMemo(
    () => domain ?? fetched.domain ?? domainOf(cells as [string, number][]),
    [domain?.[0], domain?.[1], fetched.domain, cells]
  );
  // 🌈 Шкала нужна легенде; меш строит свою копию внутри воркера
  const scale = useMemo(() => new ColorScale(palette, activeDomain), [palette, activeDomain]);

  // 4️⃣ Режим обводки зависит от размера гексагона НА ЭКРАНЕ, поэтому пересчитывается
  // при зуме. Меш при этом перестраивается только когда сам режим сменился. 🔁
  const [edgeMode, setEdgeMode] = useState<EdgeMode>('none');
  useEffect(() => {
    if (!map) return;
    const update = () => {
      if (stroke === false) return setEdgeMode('none'); // 🚫 обводка выключена
      if (stroke.mode) return setEdgeMode(stroke.mode); // 🔒 режим зафиксирован вручную
      // 📏 Берём самое мелкое разрешение из данных — по нему и решаем
      const res = layerRef.current?.resolutions;
      const r = res && res.length ? res[res.length - 1] : resFn(map.getZoom());
      setEdgeMode(
        edgeModeForView(r, map.getZoom(), map.getCenter().lat, stroke.thresholds ?? EDGE_THRESHOLDS)
      );
    };
    update();
    map.on('zoomend', update);
    map.on('moveend', update);
    return () => {
      map.off('zoomend', update);
      map.off('moveend', update);
    };
  }, [map, stroke, resFn, cells]);

  // 5️⃣ Сборщик меша: сам решает, считать на месте или отдать в Web Worker 🧵
  const builder = useMemo(
    () => new MeshBuilder(workerThreshold, workerFactory),
    [workerThreshold, workerFactory]
  );
  useEffect(() => () => builder.dispose(), [builder]); // 🧹 гасим воркер при размонтировании

  // 6️⃣ Пересборка геометрии при смене данных, палитры, диапазона или режима обводки
  useEffect(() => {
    if (!ready) return; // ⏳ слой ещё не добавлен в карту
    let live = true; // 🚦 флаг «эффект ещё актуален»
    const result = builder.build(cells, palette, activeDomain, { edges: edgeMode });
    if (result instanceof Promise) {
      // 🧵 Асинхронный путь (воркер): отбрасываем результат, если эффект уже отменён
      result.then((mesh) => {
        if (live) layerRef.current?.setMesh(mesh);
      });
    } else {
      layerRef.current?.setMesh(result); // ⚡ синхронный путь
    }
    return () => {
      live = false;
    };
  }, [ready, cells, palette, activeDomain, edgeMode, builder]);

  // 🖊️ Цвет обводки меняется без пересборки геометрии
  useEffect(() => {
    if (stroke !== false && stroke.color) layerRef.current?.setStrokeColor(stroke.color);
  }, [stroke]);

  /**
   * 🎯 Пикинг: какой гексагон под точкой?
   *
   * Никакого рендера в offscreen-буфер: считаем индекс H3 прямо из координат
   * курсора и смотрим в Map. Это O(1) и не стоит ни одного лишнего кадра. ⚡
   */
  const pick = useCallback((lng: number, lat: number): { h3: string; value: number } | null => {
    const layer = layerRef.current;
    if (!layer) return null;
    const { lookup, resolutions } = layer;
    // 🔎 Идём от самого мелкого разрешения к крупному: мелкое точнее
    for (let i = resolutions.length - 1; i >= 0; i--) {
      const h3 = latLngToCell(lat, lng, resolutions[i]);
      const value = lookup.get(h3);
      if (value !== undefined) return { h3, value };
    }
    return null; // 🕳️ под курсором пусто
  }, []);

  // 7️⃣ Мышь и тач: наведение, подсветка, клик
  useEffect(() => {
    if (!map) return;
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const hit = pick(e.lngLat.lng, e.lngLat.lat);
      const info: HoverInfo | null = hit
        ? { ...hit, x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat }
        : null;
      // ♻️ Если гексагон и точка те же — сохраняем прежний объект, чтобы React
      // не перерисовывал тултип на каждое микродвижение мыши.
      setHover((prev) => (prev?.h3 === info?.h3 && prev?.x === info?.x ? prev : info));
      layerRef.current?.setHighlight(info?.h3 ?? null); // ✨ подсветка контура
      map.getCanvas().style.cursor = info ? 'pointer' : ''; // 👆 курсор-подсказка
      onHover?.(info);
    };
    const onLeave = () => {
      setHover(null);
      layerRef.current?.setHighlight(null);
      onHover?.(null);
    };
    const onTap = (e: maplibregl.MapMouseEvent) => {
      const hit = pick(e.lngLat.lng, e.lngLat.lat);
      const info: HoverInfo | null = hit
        ? { ...hit, x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat }
        : null;
      // 📱 На тач-устройствах события mousemove не бывает, поэтому тултип
      // показываем и по тапу — иначе на телефоне подсказку не увидеть.
      setHover(info);
      layerRef.current?.setHighlight(info?.h3 ?? null);
      onClick?.(info);
    };
    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    map.on('click', onTap);
    return () => {
      map.off('mousemove', onMove);
      map.off('mouseout', onLeave);
      map.off('click', onTap);
    };
  }, [map, pick, onHover, onClick]);

  // 8️⃣ Разметка: canvas карты + слои интерфейса поверх него
  return (
    <div className={className} style={{ ...wrap, ...style }}>
      {/* 🗺️ Сюда MapLibre вставит свой canvas */}
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      {/* 💬 Тултип: обычный HTML поверх карты, а не отрисовка в GL */}
      {tooltip !== false && hover && (
        <div style={{ ...tipStyle, left: hover.x, top: hover.y }}>
          {tooltip ? (
            tooltip(hover)
          ) : (
            <>
              <div style={{ opacity: 0.7 }}>{hover.h3}</div>
              <div>{hover.value}</div>
            </>
          )}
        </div>
      )}
      {/* 🌈 Легенда палитры */}
      {legend !== false && cells.length > 0 && (
        <Legend scale={scale} title={legend.title} format={legend.format} cells={cells} />
      )}
      {/* 🧩 Своя панель управления и что угодно ещё */}
      {children}
    </div>
  );
}
