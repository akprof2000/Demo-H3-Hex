// 🛰️ Фейковый бэкенд: изображает выдачу измерений RSRP по гексагонам H3.
// В реальном проекте этот файл заменяется обычным fetch к вашему API. 🔌
import { cellToLatLng, polygonToCells } from 'h3-js';
import type { H3Cell, Viewport } from 'react-h3-map';

/** 📶 RSRP всегда в дБм и всегда отрицательный: от -40 (вплотную к антенне) до -200. */
export const DOMAIN: [number, number] = [-200, 0];

// 🗼 Сетка «базовых станций» по Москве: регулярная решётка со смещением,
// чтобы зоны обслуживания выглядели как настоящие соты, а не как шахматная доска.
const SITE_STEP = 0.022; // 📐 шаг решётки в градусах, ~1.5 км по широте
const SITE_JITTER = 0.4; // 🎲 насколько станция смещена от узла решётки

/** 🎲 Детерминированный псевдослучайный шум: одинаковый вход → одинаковый выход. */
function hashNoise(x: number, y: number): number {
  // 🧮 Классический трюк: синус большого числа даёт равномерную «кашу» в [0, 1)
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 📡 Модель сигнала в точке.
 *
 * 1. Ищем ближайшие узлы решётки станций (девять соседних клеток).
 * 2. Считаем потери на трассе по логарифмической модели.
 * 3. Добавляем крупные «тени» от застройки и мелкий разброс на гексагон.
 */
function rsrpAt(lat: number, lng: number): number {
  const kx = Math.cos(lat * (Math.PI / 180)); // 🌍 сжатие долготы на этой широте
  const gx = Math.round(lng / SITE_STEP);
  const gy = Math.round(lat / SITE_STEP);

  let best = -Infinity;
  // 🔎 Достаточно осмотреть 3×3 узла: более дальние станции заведомо слабее
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = gx + dx;
      const cy = gy + dy;
      // 🎲 Смещаем станцию внутри её клетки — соты получаются неровными, как в жизни
      const siteLng = (cx + (hashNoise(cx, cy) - 0.5) * SITE_JITTER) * SITE_STEP;
      const siteLat = (cy + (hashNoise(cy, cx) - 0.5) * SITE_JITTER) * SITE_STEP;

      // 📏 Расстояние до станции в метрах
      const dxm = (lng - siteLng) * kx * 111320;
      const dym = (lat - siteLat) * 110540;
      const d = Math.max(30, Math.hypot(dxm, dym)); // 🛡️ не ближе 30 м, иначе логарифм улетает

      // 📉 Потери: -40 дБм у самой антенны, дальше -32 дБ на каждую декаду расстояния
      const power = -40 - 31 * Math.log10(d / 30);
      if (power > best) best = power; // 🏆 «агрегация Best»: держим сильнейшую станцию
    }
  }

  // 🏙️ Крупные затенения от застройки: плавные пятна на сотни метров
  const shadow =
    10 * Math.sin(lng * 210 + lat * 90) * Math.cos(lat * 175) +
    7 * Math.sin(lat * 320 - lng * 140);

  return best + shadow;
}

const MAX_CELLS = 120_000; // 🛡️ предохранитель: столько ячеек за раз более чем достаточно

/** 🌐 Имитация HTTP-эндпоинта: отдаёт [[h3, rsrp], ...] для видимой области. */
export async function fetchHexes(vp: Viewport, signal: AbortSignal): Promise<H3Cell[]> {
  const [w, s, e, n] = vp.bbox;
  // 🖼️ Небольшой запас за краями экрана, чтобы при панораме не мигали пустые поля
  const padX = (e - w) * 0.15;
  const padY = (n - s) * 0.15;
  const poly: number[][] = [
    [s - padY, w - padX],
    [s - padY, e + padX],
    [n + padY, e + padX],
    [n + padY, w - padX],
  ];

  let res = vp.resolution;
  let cells = polygonToCells(poly, res); // 🧱 все ячейки внутри прямоугольника
  // 🛡️ Если разрешение слишком мелкое для такой области — огрубляем
  while (cells.length > MAX_CELLS && res > 6) {
    cells = polygonToCells(poly, --res);
  }

  // ⏱️ Сетевая задержка, чтобы было видно работу дебаунса и отмены запросов
  await new Promise((r) => setTimeout(r, 120));
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');

  const out: H3Cell[] = new Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const [lat, lng] = cellToLatLng(cells[i]); // 📍 центр гексагона
    // 🎲 Разброс измерения внутри ячейки: ±9 дБ, но детерминированный —
    // при панораме и зуме одна и та же ячейка сохраняет свой цвет.
    const noise = hashNoise(lat * 1e4, lng * 1e4);
    let jitter = (noise - 0.5) * 18;
    // 🕳️ Редкие глубокие замирания: подвал, двор-колодец, экран из зданий.
    // Именно они дают на карте одиночные красные и чёрные точки.
    const fade = hashNoise(lng * 1e4, lat * 1e4);
    if (fade < 0.03) jitter -= 12 + fade * 400;
    const value = Math.max(-200, Math.min(-40, rsrpAt(lat, lng) + jitter));
    out[i] = [cells[i], Math.round(value * 10) / 10];
  }
  return out;
}
