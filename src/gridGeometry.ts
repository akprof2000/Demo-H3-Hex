// 🕸️ Геометрия «пустой» сетки H3: гексагоны без заливки, только границы.
//
// Отличие от `geometry.ts`: там мы раскрашиваем ПРИШЕДШИЕ данные, а здесь
// данных нет вообще — ячейки мы придумываем сами по видимой области экрана.
// Поэтому файл маленький и занимается ровно двумя вещами:
//   1. подобрать список ячеек, накрывающих экран;
//   2. превратить их в один плоский буфер отрезков для GPU. ➖
import {
  directedEdgeToBoundary, // 📐 геометрия одного направленного ребра
  getDirectedEdgeDestination, // 👉 сосед по ту сторону ребра
  getHexagonAreaAvg, // 📏 средняя площадь ячейки разрешения
  originToDirectedEdges, // 🔢 6 (или 5) рёбер ячейки
  polygonToCells, // 🧮 полигон → список ячеек внутри него
  UNITS,
} from 'h3-js';
// ♻️ Переиспользуем проекцию из основного модуля: одна формула на весь проект,
// иначе сетка и данные разъедутся на доли пикселя.
import { edgePixels, latToMercY, lngToMercX } from './geometry';

/** 🖼️ Прямоугольник видимой области: [запад, юг, восток, север] в градусах. */
export type BBox = [west: number, south: number, east: number, north: number];

/**
 * 📦 Линии, развёрнутые в треугольники — готовый к отправке в GPU набор буферов.
 *
 * ⚠️ Почему не `gl.LINES` с `gl.lineWidth(2)`: толщина линии больше 1 в WebGL
 * не поддерживается практически нигде. В спецификации она разрешена, но ANGLE
 * (а через него — Chrome и Edge на Windows) жёстко ограничивает диапазон
 * значением 1, и вызов просто ничего не делает. Единственный работающий способ
 * получить толстую линию — нарисовать её прямоугольником из двух треугольников
 * и раздвинуть его на нужную ширину прямо в вершинном шейдере. 📐
 *
 * Отсюда и три буфера вместо одного: на каждый отрезок приходится 4 вершины,
 * и каждая должна знать, куда смещаться.
 */
export interface LineMesh {
  /** 📍 Вершина отрезка — та, из которой она «выросла» (mercator, минус origin). */
  positions: Float32Array;
  /** 👉 Второй конец того же отрезка: по нему шейдер считает направление. */
  others: Float32Array;
  /** ↔️ Сторона смещения: +1 или −1 (в какую сторону от оси отрезка отойти). */
  sides: Float32Array;
  /** 🔺 Индексы треугольников: 6 на отрезок (два треугольника на прямоугольник). */
  indices: Uint32Array;
  /** 🔢 Сколько индексов рисовать. */
  indexCount: number;
}

/** 🕳️ Пустой набор линий. */
export const EMPTY_LINES: LineMesh = {
  positions: new Float32Array(0),
  others: new Float32Array(0),
  sides: new Float32Array(0),
  indices: new Uint32Array(0),
  indexCount: 0,
};

/** 📦 Готовый к отправке в GPU набор линий сетки. */
export interface GridMesh extends LineMesh {
  /** 🧭 Мировая точка отсчёта, вычтенная из positions (борьба с точностью float32). */
  origin: [number, number];
  /** 🧱 Ячейки, попавшие в сетку — нужны для пикинга и статистики. */
  cells: string[];
  /** 📏 Разрешение H3, на котором построена сетка. */
  resolution: number;
}

/** 🕳️ Пустая сетка — отдаём вместо null, чтобы не плодить проверки. */
export const EMPTY_GRID: GridMesh = {
  ...EMPTY_LINES,
  origin: [0, 0],
  cells: [],
  resolution: 0,
};

/**
 * 📐 Пары точек → прямоугольники.
 *
 * На вход — плоский массив отрезков: x0,y0, x1,y1, x0,y0, x1,y1, … (ровно тот
 * формат, что раньше уходил в `gl.LINES`). На выход — четыре буфера, из которых
 * вершинный шейдер соберёт полоску нужной толщины.
 *
 * Раскладка на один отрезок AB:
 * ```
 *   вершина 0: pos=A other=B side=+1     0 ──── 2     ↑ side +1
 *   вершина 1: pos=A other=B side=−1     │      │     ось отрезка A→B
 *   вершина 2: pos=B other=A side=−1     1 ──── 3     ↓ side −1
 *   вершина 3: pos=B other=A side=+1
 * ```
 * ⚠️ У вершин 2 и 3 знак `side` перевёрнут: направление отрезка для них тоже
 * противоположно (B→A), и без этой перестановки прямоугольник свернулся бы
 * восьмёркой — «песочными часами» на экране. ⏳
 *
 * ⚠️ Второй подвох — порядок индексов. Треугольники обязаны обходиться в одну
 * сторону: при разном обходе включённое отсечение задних граней съедает ровно
 * половину прямоугольника, и линия выходит вдвое тоньше заказанной, причём
 * смещённой на свою толщину. Ловится это только глазами или подсчётом пикселей,
 * поэтому: обход по кольцу 0 → 1 → 3 → 2, а не «0-1-2 / 0-2-3». 🔁
 */
export function expandSegments(segs: Float32Array): LineMesh {
  const segCount = segs.length / 4; // 🔢 4 числа (две точки) на отрезок
  if (segCount === 0) return EMPTY_LINES;

  const positions = new Float32Array(segCount * 4 * 2); // 4 вершины × (x, y)
  const others = new Float32Array(segCount * 4 * 2);
  const sides = new Float32Array(segCount * 4);
  const indices = new Uint32Array(segCount * 6); // 🔺 два треугольника на отрезок

  for (let s = 0; s < segCount; s++) {
    const ax = segs[s * 4];
    const ay = segs[s * 4 + 1];
    const bx = segs[s * 4 + 2];
    const by = segs[s * 4 + 3];

    const v = s * 4; // 📌 индекс первой вершины этого отрезка
    // 📍 Две вершины «растут» из A и смотрят на B, две — наоборот
    for (const [i, px, py, ox, oy, side] of [
      [0, ax, ay, bx, by, 1],
      [1, ax, ay, bx, by, -1],
      [2, bx, by, ax, ay, -1],
      [3, bx, by, ax, ay, 1],
    ] as const) {
      positions[(v + i) * 2] = px;
      positions[(v + i) * 2 + 1] = py;
      others[(v + i) * 2] = ox;
      others[(v + i) * 2 + 1] = oy;
      sides[v + i] = side;
    }

    // 🔺 Прямоугольник из двух треугольников по кольцу 0 → 1 → 3 → 2:
    // оба обходятся в одну сторону (см. предупреждение в описании функции)
    const t = s * 6;
    indices[t] = v;
    indices[t + 1] = v + 1;
    indices[t + 2] = v + 3;
    indices[t + 3] = v;
    indices[t + 4] = v + 3;
    indices[t + 5] = v + 2;
  }

  return { positions, others, sides, indices, indexCount: indices.length };
}

/**
 * 🔁 Замкнутый контур (x0,y0, x1,y1, …) → отрезки в формате `expandSegments`.
 * Нужен для подсветки ячейки под курсором: раньше её рисовал `gl.LINE_LOOP`,
 * который тоже умеет толщину только в 1 пиксель.
 */
export function loopToSegments(loop: Float32Array): Float32Array {
  const n = loop.length / 2; // 🔢 точек в контуре
  if (n < 2) return new Float32Array(0);
  const out = new Float32Array(n * 4); // ➖ столько же отрезков, сколько точек
  for (let k = 0; k < n; k++) {
    const next = (k + 1) % n; // 🔁 последняя точка замыкается на первую
    out[k * 4] = loop[k * 2];
    out[k * 4 + 1] = loop[k * 2 + 1];
    out[k * 4 + 2] = loop[next * 2];
    out[k * 4 + 3] = loop[next * 2 + 1];
  }
  return out;
}

// 🌍 Приблизительные размеры одного градуса на поверхности Земли, в километрах.
// Точность здесь не важна: числа нужны только для оценки «сколько ячеек выйдет».
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG = 111.32;
const D2R = Math.PI / 180;

/**
 * 🧮 Оценка числа ячеек разрешения `resolution` внутри прямоугольника.
 *
 * Зачем оценивать, а не просто вызвать `polygonToCells` и посмотреть длину:
 * на разрешении 12 в масштабе города ячеек десятки миллионов, и сам вызов
 * подвесит вкладку на минуты. Дешёвая оценка «площадь / площадь ячейки»
 * позволяет отказаться от построения ДО того, как станет больно. 🛡️
 */
export function estimateCellCount(bbox: BBox, resolution: number): number {
  const [west, south, east, north] = bbox;
  const midLat = (south + north) / 2; // 🧭 широта середины экрана
  const heightKm = Math.abs(north - south) * KM_PER_DEG_LAT;
  // ↔️ Меридианы сходятся к полюсам: ширина градуса долготы умножается на cos(широты)
  const widthKm = Math.abs(east - west) * KM_PER_DEG_LNG * Math.cos(midLat * D2R);
  const areaKm2 = widthKm * heightKm;
  const cellKm2 = getHexagonAreaAvg(resolution, UNITS.km2); // 📐 площадь одной ячейки
  return Math.ceil(areaKm2 / cellKm2);
}

/**
 * 🎚️ Подбор разрешения так, чтобы ребро гексагона занимало на экране
 * примерно `targetPx` пикселей.
 *
 * Идём от крупного к мелкому и останавливаемся, как только ребро стало
 * меньше цели: предыдущее разрешение было слишком крупным, это — в самый раз.
 */
export function resolutionForEdgePixels(zoom: number, lat: number, targetPx: number): number {
  for (let r = 0; r <= 15; r++) {
    if (edgePixels(r, zoom, lat) <= targetPx) return r; // 🎯 нашли подходящее
  }
  return 15; // 🔬 мельче H3 не умеет
}

/**
 * ✂️ Приведение прямоугольника в допустимые границы + небольшой запас по краям.
 *
 * Запас нужен, чтобы гексагоны, центр которых чуть за экраном, всё равно
 * попали в список: иначе по краю карты сетка будет обрываться «зубцами». 🧩
 */
export function padBBox(bbox: BBox, pad = 0.08): BBox {
  const [west, south, east, north] = bbox;
  const dx = (east - west) * pad; // ↔️ запас по горизонтали
  const dy = (north - south) * pad; // ↕️ запас по вертикали
  return [
    Math.max(west - dx, -180), // 🚧 за −180° долготы уходить нельзя
    Math.max(south - dy, -85.05), // 🚧 полюса в меркаторе бесконечны — подрезаем
    Math.min(east + dx, 180),
    Math.min(north + dy, 85.05),
  ];
}

/**
 * 🧱 Список ячеек H3, накрывающих прямоугольник.
 *
 * `polygonToCells` принимает контур; в GeoJSON-режиме (третий аргумент `true`)
 * координаты идут парами [lng, lat] — так же, как во всём остальном коде. 🔁
 */
export function cellsForBBox(bbox: BBox, resolution: number): string[] {
  const [west, south, east, north] = bbox;
  // 🔷 Контур прямоугольника против часовой стрелки; замыкать его вручную не нужно
  const ring: [number, number][] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
  return polygonToCells([ring], resolution, true);
}

/**
 * 🏗️ Список ячеек → буфер отрезков.
 *
 * Каждое ребро рисуется РОВНО ОДИН раз. Без этого соседние гексагоны рисовали бы
 * общую границу дважды: линия становится вдвое ярче на стыках и вдвое дороже
 * по вершинам. Дедупликация топологическая, через directed edges: у ребра есть
 * ячейка-источник и ячейка-приёмник, и мы оставляем ребро за той из двух, чей
 * индекс лексикографически меньше. 🎯
 */
export function buildGridMesh(cells: string[], resolution: number): GridMesh {
  const n = cells.length;
  if (n === 0) return EMPTY_GRID; // 🚪 ранний выход

  const present = new Set(cells); // 🔍 быстрая проверка «сосед тоже в сетке?»
  // 🧮 Оценка сверху: 6 рёбер × до 3 сегментов × 2 вершины × 2 числа на вершину.
  // Сегментов больше одного бывает только на гранях икосаэдра H3.
  const out = new Float32Array(n * 6 * 3 * 2 * 2);
  let p = 0; // ✍️ позиция записи в буфер
  let ox = 0; // 🧭 origin по X
  let oy = 0; // 🧭 origin по Y
  let originSet = false;

  for (let c = 0; c < n; c++) {
    const h3 = cells[c];

    for (const edge of originToDirectedEdges(h3)) {
      const neighbor = getDirectedEdgeDestination(edge); // 👉 кто с той стороны
      // 🙈 Сосед тоже в сетке и его индекс меньше — значит, ребро уже нарисовано им
      if (present.has(neighbor) && h3 > neighbor) continue;

      const pts = directedEdgeToBoundary(edge, true); // 📐 [lng, lat][] этого ребра
      const lng0 = pts[0][0]; // 📌 опорная долгота для склейки через антимеридиан

      if (!originSet) {
        // 🧭 Первая же точка становится точкой отсчёта: все координаты хранятся
        // относительно неё, иначе на зумах 15+ у float32 не хватит мантиссы
        // и линии начнут «дрожать» при панораме.
        ox = lngToMercX(lng0);
        oy = latToMercY(pts[0][1]);
        originSet = true;
      }

      for (let k = 0; k < pts.length - 1; k++) {
        // ➖ Копим независимые отрезки: обе точки каждого сегмента подряд
        for (const idx of [k, k + 1] as const) {
          let lng = pts[idx][0];
          // 🌍 Антимеридиан: держим отрезок цельным относительно первой точки,
          // иначе он растянется через весь мир поперёк карты.
          if (lng - lng0 > 180) lng -= 360;
          else if (lng0 - lng > 180) lng += 360;
          out[p++] = lngToMercX(lng) - ox; // ➖ вычитание origin ещё в double
          out[p++] = latToMercY(pts[idx][1]) - oy;
        }
      }
    }
  }

  // ✂️ Обрезаем запас и разворачиваем отрезки в треугольники нужной толщины
  return {
    ...expandSegments(out.subarray(0, p)),
    origin: [ox, oy],
    cells,
    resolution,
  };
}
