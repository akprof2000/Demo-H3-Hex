// 🎨 Палитра: превращаем число (метрику) в цвет.
// Главная идея — не интерполировать цвет на каждый гексагон, а один раз
// развернуть палитру в таблицу на 512 записей и дальше просто брать по индексу. ⚡
import type { Palette, RGBA } from './types';

const LUT_SIZE = 512; // 📊 столько ступеней в таблице: глазу этого с запасом хватает

/** 🔤 "#rrggbb" / "#rgb" / "#rrggbbaa" / [r,g,b,a] → [r, g, b, a] в диапазоне 0..255 */
function parseColor(c: string | RGBA): RGBA {
  if (typeof c !== 'string') return c; // ✅ уже массив — ничего не делаем
  let h = c.trim();
  if (h[0] === '#') h = h.slice(1); // ✂️ решётка не нужна
  // 🔁 Короткая форма "#abc" → "aabbcc"
  if (h.length === 3 || h.length === 4) h = h.replace(/./g, (ch) => ch + ch);
  const n = parseInt(h.slice(0, 8), 16);
  if (h.length >= 8) {
    // 🧮 Побитово достаём каналы: сдвиг вправо + маска на 8 бит
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  return [(n >>> 16) & 255, (n >>> 8) & 255, n & 255, 255]; // 🚫 альфы не было → непрозрачный
}

/**
 * 🌈 Цветовая шкала: значение → RGBA.
 *
 * Как менять под себя: передайте свои `colors` (сколько угодно опорных цветов),
 * а `domain` задайте фиксированным, если не хотите, чтобы цвета «прыгали»
 * при смене данных. 🔒
 */
export class ColorScale {
  readonly lut: Uint8Array; // 📋 сама таблица: LUT_SIZE × RGBA
  readonly min: number; // 📉 нижняя граница диапазона значений
  readonly max: number; // 📈 верхняя граница
  private readonly scale: number; // ✖️ множитель «значение → индекс в таблице»

  constructor(palette: Palette, domain: [number, number]) {
    const stops = palette.colors.map(parseColor); // 🎨 опорные цвета
    const opacity = palette.opacity ?? 1; // 👻 общая непрозрачность слоя
    const lut = new Uint8Array(LUT_SIZE * 4);
    const seg = stops.length - 1; // ➗ сколько отрезков между опорными цветами

    for (let i = 0; i < LUT_SIZE; i++) {
      // 📍 Где мы находимся на шкале опорных цветов: 0..seg
      const t = seg <= 0 ? 0 : (i / (LUT_SIZE - 1)) * seg;
      const i0 = Math.min(Math.floor(t), Math.max(seg - 1, 0)); // ⬅️ левый опорный цвет
      const f = t - i0; // 🧪 доля перехода к правому, 0..1
      const a = stops[i0];
      const b = stops[Math.min(i0 + 1, seg)] ?? a; // ➡️ правый (на конце шкалы — тот же)
      const o = i * 4;
      // 🖌️ Линейная интерполяция по каждому каналу
      lut[o] = a[0] + (b[0] - a[0]) * f;
      lut[o + 1] = a[1] + (b[1] - a[1]) * f;
      lut[o + 2] = a[2] + (b[2] - a[2]) * f;
      lut[o + 3] = (a[3] + (b[3] - a[3]) * f) * opacity; // 👻 альфа домножается на opacity
    }

    this.lut = lut;
    this.min = domain[0];
    this.max = domain[1];
    // ⚠️ Вырожденный диапазон (все значения равны) — иначе делили бы на ноль
    this.scale = domain[1] === domain[0] ? 0 : (LUT_SIZE - 1) / (domain[1] - domain[0]);
  }

  /** 🔢 Смещение в таблице (уже умноженное на 4) — самая горячая операция. */
  offset(value: number): number {
    let i = (value - this.min) * this.scale;
    i = i < 0 ? 0 : i > LUT_SIZE - 1 ? LUT_SIZE - 1 : i; // ✂️ подрезаем выбросы к краям шкалы
    return (i | 0) * 4; // ⚡ `| 0` — быстрое отбрасывание дробной части
  }

  /** 🎨 Цвет значения как [r, g, b, a]. */
  rgba(value: number): RGBA {
    const o = this.offset(value);
    return [this.lut[o], this.lut[o + 1], this.lut[o + 2], this.lut[o + 3]];
  }

  /** 🖥️ Цвет значения как CSS-строка — нужен легенде и тултипу. */
  css(value: number): string {
    const [r, g, b, a] = this.rgba(value);
    return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
  }
}

/** 🔥 Палитра по умолчанию — тёмно-фиолетовый → жёлтый, читаемо на тёмной карте. */
export const DEFAULT_PALETTE: Palette = {
  colors: ['#2b0b3f', '#5b1f7a', '#a52f7a', '#e05c4f', '#f7a838', '#f9f871'],
  opacity: 0.8,
};

/** 📐 Диапазон значений по данным — используется, если `domain` не задан явно. */
export function domainOf(cells: readonly [string, number][]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i][1];
    if (v < min) min = v; // 📉
    if (v > max) max = v; // 📈
  }
  return min <= max ? [min, max] : [0, 1]; // 🕳️ пустые данные → безопасный диапазон
}
