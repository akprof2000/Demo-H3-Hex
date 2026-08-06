// 📐 Геометрия: превращаем индексы H3 в готовые для GPU буферы.
// Здесь нет ни React, ни WebGL — только чистые вычисления, поэтому этот модуль
// без изменений работает и в Web Worker. 🧵
import {
  cellToBoundary,
  directedEdgeToBoundary,
  getDirectedEdgeDestination,
  getHexagonEdgeLengthAvg,
  getResolution,
  originToDirectedEdges,
  UNITS,
} from 'h3-js';
import type { ColorScale } from './palette';
import type { H3Cell } from './types';

const D2R = Math.PI / 180; // 🔁 градусы → радианы, чтобы не считать каждый раз

// 🗺️ Web-Mercator в единичном квадрате [0..1] — ровно та система координат,
// в которой MapLibre отдаёт нам матрицу проекции.
export function lngToMercX(lng: number): number {
  return (180 + lng) / 360; // ↔️ долгота линейна, всё просто
}
export function latToMercY(lat: number): number {
  // ✂️ Подрезаем полюса: за пределами ±85.051129° меркатор уходит в бесконечность
  const s = Math.min(Math.max(lat, -85.051129), 85.051129);
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (s * D2R) / 2))) / 360;
}

/** 📦 Готовый к загрузке в GPU набор буферов. */
export interface HexMesh {
  positions: Float32Array; // 📍 2 float на вершину, ОТНОСИТЕЛЬНО origin
  colors: Uint8Array; // 🎨 4 байта (RGBA) на вершину
  indices: Uint32Array; // 🔺 индексы треугольников заливки
  /** ➖ Индексы рёбер поверх тех же вершин (режим `all`). */
  edgeIndices: Uint32Array;
  /** ➖ Отдельные вершины линий, парами (режим `boundary`). */
  edgePositions: Float32Array;
  origin: [number, number]; // 🧭 мировые mercator-координаты, вычтенные из positions
  vertexCount: number; // 🔢 сколько индексов рисовать (не вершин!)
  /** 🔍 h3 → значение: по этой карте работает пикинг и тултип. */
  lookup: Map<string, number>;
  /** 📏 Разрешения H3, встретившиеся в данных (обычно ровно одно). */
  resolutions: number[];
}

// 🕳️ Пустой меш — отдаём его, когда данных нет, чтобы не плодить проверки на null
const EMPTY: HexMesh = {
  positions: new Float32Array(0),
  colors: new Uint8Array(0),
  indices: new Uint32Array(0),
  edgeIndices: new Uint32Array(0),
  edgePositions: new Float32Array(0),
  origin: [0, 0],
  vertexCount: 0,
  lookup: new Map(),
  resolutions: [],
};

/**
 * 🖊️ Режим обводки:
 * - `all` — все рёбра каждого гексагона (когда гексы крупные на экране);
 * - `boundary` — только границы между разными цветами и внешний контур данных;
 * - `none` — без обводки (мелкие гексы, иначе экран превращается в рябь 🌫️).
 */
export type EdgeMode = 'none' | 'all' | 'boundary';

export interface BuildOptions {
  edges?: EdgeMode;
}

/** 📏 Пороги в CSS-пикселях на длину ребра гексагона. */
export const EDGE_THRESHOLDS = { all: 14, boundary: 4 };

/** 🔬 Сколько экранных пикселей занимает ребро гексагона данного разрешения. */
export function edgePixels(resolution: number, zoom: number, lat: number): number {
  const meters = getHexagonEdgeLengthAvg(resolution, UNITS.m); // 📐 средняя длина ребра в метрах
  // 🖥️ В MapLibre на зуме 0 весь мир — 512 пикселей, отсюда метры на пиксель.
  const metersPerPixel = (40075016.686 * Math.cos(lat * D2R)) / (512 * 2 ** zoom);
  return meters / metersPerPixel;
}

/**
 * 🤖 Автоматический выбор режима обводки: крупные гексы — полная сетка,
 * средние — только границы цветов, мелкие — вообще без линий.
 */
export function edgeModeForView(
  resolution: number,
  zoom: number,
  lat: number,
  thresholds = EDGE_THRESHOLDS
): EdgeMode {
  const px = edgePixels(resolution, zoom, lat); // 📏 размер ребра на экране
  if (px >= thresholds.all) return 'all'; // 🟢 крупно — рисуем всю сетку
  if (px >= thresholds.boundary) return 'boundary'; // 🟡 средне — только границы цветов
  return 'none'; // 🔴 мелко — линии только зашумят картинку
}

/**
 * 🏗️ Главная функция: один проход по данным превращает массив [[h3, value], ...]
 * в вершины, цвета и индексы. Гексагон выпуклый, поэтому триангуляция «веером»
 * (0-1-2, 0-2-3, 0-3-4, ...) корректна и не требует earcut. 🍰
 */
export function buildMesh(
  cells: readonly H3Cell[],
  scale: ColorScale,
  opts: BuildOptions = {}
): HexMesh {
  const n = cells.length;
  if (n === 0) return EMPTY; // 🚪 ранний выход на пустых данных

  const mode = opts.edges ?? 'none';

  // 🧮 Аллоцируем с запасом «сверху»: обычный гексагон даёт 6 вершин, но на
  // гранях икосаэдра h3 вставляет дополнительные, поэтому берём 10 на ячейку.
  const maxVerts = n * 10;
  const positions = new Float32Array(maxVerts * 2);
  const colors = new Uint8Array(maxVerts * 4);
  const indices = new Uint32Array(maxVerts * 3);
  // ➖ Индексы рёбер нужны только в режиме `all` — переиспользуют вершины заливки
  const edgeIndices = mode === 'all' ? new Uint32Array(maxVerts * 2) : null;
  const lookup = new Map<string, number>(); // 🔍 карта для пикинга
  const resSet = new Set<number>(); // 📏 какие разрешения встретились
  const lut = scale.lut; // 🎨 таблица цветов — читаем напрямую, без вызовов

  let vi = 0; // 📍 счётчик вершин
  let ii = 0; // 🔺 счётчик индексов треугольников
  let ei = 0; // ➖ счётчик индексов рёбер
  let ox = 0; // 🧭 origin по X
  let oy = 0; // 🧭 origin по Y
  let originSet = false;

  for (let c = 0; c < n; c++) {
    const h3 = cells[c][0];
    const value = cells[c][1];
    lookup.set(h3, value); // 🔍 пригодится при наведении мыши
    resSet.add(getResolution(h3)); // 📏 запоминаем разрешение ячейки

    const boundary = cellToBoundary(h3, true); // 🔷 контур ячейки: [lng, lat][]
    const len = boundary.length;
    if (len < 3) continue; // 🛑 вырожденная ячейка — пропускаем

    if (!originSet) {
      // 🧭 Первая вершина становится точкой отсчёта. Все позиции хранятся
      // относительно неё, иначе float32 не хватит точности на больших зумах.
      ox = lngToMercX(boundary[0][0]);
      oy = latToMercY(boundary[0][1]);
      originSet = true;
    }

    // 🎨 Цвет ячейки — одно обращение в таблицу, без интерполяции на месте
    const co = scale.offset(value);
    const r = lut[co];
    const g = lut[co + 1];
    const b = lut[co + 2];
    const a = lut[co + 3];

    const base = vi; // 📌 индекс первой вершины этой ячейки
    const lng0 = boundary[0][0];
    for (let k = 0; k < len; k++) {
      let lng = boundary[k][0];
      // 🌍 Антимеридиан: держим полигон цельным относительно первой вершины,
      // иначе ячейка растянется через весь мир.
      if (lng - lng0 > 180) lng -= 360;
      else if (lng0 - lng > 180) lng += 360;

      positions[vi * 2] = lngToMercX(lng) - ox; // ➖ вычитание origin в double
      positions[vi * 2 + 1] = latToMercY(boundary[k][1]) - oy;
      const o = vi * 4;
      colors[o] = r; // 🎨 цвет дублируется на каждую вершину ячейки
      colors[o + 1] = g;
      colors[o + 2] = b;
      colors[o + 3] = a;
      vi++;
    }

    // 🔺 Веер треугольников от нулевой вершины
    for (let k = 1; k < len - 1; k++) {
      indices[ii++] = base;
      indices[ii++] = base + k;
      indices[ii++] = base + k + 1;
    }

    // ➖ Полная сетка: замкнутый контур по вершинам ячейки
    if (edgeIndices) {
      for (let k = 0; k < len; k++) {
        edgeIndices[ei++] = base + k;
        edgeIndices[ei++] = base + ((k + 1) % len);
      }
    }
  }

  const origin: [number, number] = [ox, oy];

  return {
    positions: positions.subarray(0, vi * 2), // ✂️ обрезаем запас
    colors: colors.subarray(0, vi * 4),
    indices: indices.subarray(0, ii),
    edgeIndices: edgeIndices ? edgeIndices.subarray(0, ei) : EMPTY.edgeIndices,
    // 🖊️ Границы между цветами считаются отдельным проходом: ему нужен уже
    // заполненный lookup, чтобы знать цвета соседей.
    edgePositions:
      mode === 'boundary' ? buildColorBoundaries(cells, scale, lookup, origin) : EMPTY.edgePositions,
    origin,
    vertexCount: ii,
    lookup,
    resolutions: [...resSet].sort((x, y) => x - y),
  };
}

/**
 * 🧩 Границы между разными цветами.
 *
 * Сравнивать вершины геометрически нельзя: на гранях икосаэдра h3 вставляет
 * дополнительные точки, и у двух соседей общее ребро описано РАЗНЫМ числом
 * вершин. Поэтому идём топологически — через directed edges: у каждой ячейки
 * ровно 6 (у пентагона 5) направленных рёбер, каждое знает своего соседа. 🎯
 */
function buildColorBoundaries(
  cells: readonly H3Cell[],
  scale: ColorScale,
  lookup: Map<string, number>,
  origin: [number, number]
): Float32Array {
  // 🧮 Верхняя оценка: 6 рёбер на ячейку, до 3 сегментов на ребро, 2 вершины на сегмент
  const out = new Float32Array(cells.length * 6 * 3 * 2 * 2);
  let p = 0;

  for (let c = 0; c < cells.length; c++) {
    const h3 = cells[c][0];
    const myColor = scale.offset(cells[c][1]); // 🎨 «цветовой ключ» ячейки

    for (const edge of originToDirectedEdges(h3)) {
      const neighbor = getDirectedEdgeDestination(edge); // 👉 кто по ту сторону ребра
      const neighborValue = lookup.get(neighbor);

      if (neighborValue !== undefined) {
        // 🤝 Сосед есть в данных: рисуем ребро только если цвета различаются...
        if (scale.offset(neighborValue) === myColor) continue; // 🙈 один цвет — линия не нужна
        // ...и только с одной стороны, иначе линия ляжет дважды 👯
        if (h3 > neighbor) continue;
      }
      // 🚧 Соседа нет в данных → это внешний контур набора, рисуем всегда

      // 📐 Геометрия именно этого ребра, со всеми вставленными вершинами
      const pts = directedEdgeToBoundary(edge, true); // [lng, lat][]
      const lng0 = pts[0][0];
      for (let k = 0; k < pts.length - 1; k++) {
        // ➖ gl.LINES рисует независимые отрезки: пишем обе точки каждого сегмента
        for (const idx of [k, k + 1] as const) {
          let lng = pts[idx][0];
          if (lng - lng0 > 180) lng -= 360; // 🌍 та же защита от антимеридиана
          else if (lng0 - lng > 180) lng += 360;
          out[p++] = lngToMercX(lng) - origin[0];
          out[p++] = latToMercY(pts[idx][1]) - origin[1];
        }
      }
    }
  }
  return out.subarray(0, p); // ✂️ отдаём ровно заполненную часть
}

/** ✨ Контур одного гексагона — для подсветки того, что под курсором. */
export function buildOutline(h3: string, origin: [number, number]): Float32Array {
  const boundary = cellToBoundary(h3, true);
  const out = new Float32Array(boundary.length * 2);
  const lng0 = boundary[0][0];
  for (let k = 0; k < boundary.length; k++) {
    let lng = boundary[k][0];
    if (lng - lng0 > 180) lng -= 360; // 🌍 антимеридиан
    else if (lng0 - lng > 180) lng += 360;
    out[k * 2] = lngToMercX(lng) - origin[0];
    out[k * 2 + 1] = latToMercY(boundary[k][1]) - origin[1];
  }
  return out;
}
