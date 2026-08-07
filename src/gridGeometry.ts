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

/** 📦 Готовый к отправке в GPU набор линий сетки. */
export interface GridMesh {
  /** ➖ Пары вершин отрезков (gl.LINES), в mercator-координатах ОТНОСИТЕЛЬНО origin. */
  positions: Float32Array;
  /** 🧭 Мировая точка отсчёта, вычтенная из positions (борьба с точностью float32). */
  origin: [number, number];
  /** 🔢 Сколько вершин рисовать: positions.length / 2. */
  vertexCount: number;
  /** 🧱 Ячейки, попавшие в сетку — нужны для пикинга и статистики. */
  cells: string[];
  /** 📏 Разрешение H3, на котором построена сетка. */
  resolution: number;
}

/** 🕳️ Пустая сетка — отдаём вместо null, чтобы не плодить проверки. */
export const EMPTY_GRID: GridMesh = {
  positions: new Float32Array(0),
  origin: [0, 0],
  vertexCount: 0,
  cells: [],
  resolution: 0,
};

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
        // ➖ gl.LINES рисует НЕзависимые отрезки: пишем обе точки каждого сегмента
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

  const positions = out.subarray(0, p); // ✂️ отдаём ровно заполненную часть
  return {
    positions,
    origin: [ox, oy],
    vertexCount: p / 2, // 🔢 два числа на вершину
    cells,
    resolution,
  };
}
