// 🎨 Палитра: превращаем число (метрику) в цвет.
// Главная идея — не интерполировать цвет на каждый гексагон, а один раз
// развернуть палитру в таблицу на 512 записей и дальше просто брать по индексу. ⚡
import type { Palette, PaletteBin, RGBA } from './types';

const LUT_SIZE = 512; // 📊 столько ступеней в таблице: глазу этого с запасом хватает
// 🪜 Для дискретной шкалы таблица подробнее: иначе границы диапазонов
// (например, ровно −90 дБм) размывались бы на полступени.
const BIN_LUT_SIZE = 8192;

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
  readonly lut: Uint8Array; // 📋 сама таблица: size × RGBA
  readonly min: number; // 📉 нижняя граница диапазона значений
  readonly max: number; // 📈 верхняя граница
  private readonly size: number; // 📊 число ступеней в таблице
  private readonly scale: number; // ✖️ множитель «значение → индекс в таблице»

  /** 🪜 Дискретные диапазоны, если шкала ступенчатая (нужны легенде). */
  readonly bins: PaletteBin[] | null;

  constructor(palette: Palette, domain: [number, number]) {
    const opacity = palette.opacity ?? 1; // 👻 общая непрозрачность слоя
    this.bins = palette.bins ?? null;
    this.size = this.bins ? BIN_LUT_SIZE : LUT_SIZE;
    const lut = new Uint8Array(this.size * 4);

    // 🪜 Ступенчатый режим: цвет берётся целиком по диапазону.
    // Так раскрашивают радиопокрытие, где важны именно пороги, а не плавность.
    if (palette.bins && palette.bins.length > 0) {
      const bins = palette.bins.map((b) => ({ ...b, rgba: parseColor(b.color) }));
      // 📐 Диапазон шкалы охватывает все ступени, чтобы ни одна не «схлопнулась»
      const lo = Math.min(...bins.map((b) => b.from), domain[0]);
      const hi = Math.max(...bins.map((b) => b.to), domain[1]);
      const noData = parseColor(palette.noDataColor ?? [128, 128, 128, 255]); // ⬜ вне диапазонов

      for (let i = 0; i < this.size; i++) {
        const v = lo + ((hi - lo) * i) / (this.size - 1); // 🔢 значение этой ступени таблицы
        // 🔎 Верхняя граница исключительна, кроме самой последней ступени
        const bin = bins.find((b) => v >= b.from && (v < b.to || (v === hi && b.to === hi)));
        const c = bin ? bin.rgba : noData;
        const o = i * 4;
        lut[o] = c[0];
        lut[o + 1] = c[1];
        lut[o + 2] = c[2];
        lut[o + 3] = c[3] * opacity;
      }

      this.lut = lut;
      this.min = lo;
      this.max = hi;
      this.scale = hi === lo ? 0 : (this.size - 1) / (hi - lo);
      return;
    }

    const stops = palette.colors.map(parseColor); // 🎨 опорные цвета
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
    i = i < 0 ? 0 : i > this.size - 1 ? this.size - 1 : i; // ✂️ подрезаем выбросы к краям шкалы
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

/**
 * 📶 Готовая шкала RSRP (мощность опорного сигнала LTE/NR, дБм) —
 * стандартные пороги, принятые в радиопланировании.
 *
 * Меняете под свой показатель? Скопируйте структуру и подставьте свои `from`/`to`. 🔧
 */
export const RSRP_PALETTE: Palette = {
  colors: [], // 🚫 не используется: шкала дискретная
  opacity: 0.85,
  noDataColor: '#9e9e9e', // ⬜ «без значения»
  bins: [
    { from: -70, to: 0, color: '#1414ff', label: '-70 … 0' }, // 🔵 отличный сигнал
    { from: -90, to: -70, color: '#1c7a1c', label: '-90 … -70' }, // 🌲 хороший
    { from: -100, to: -90, color: '#78d278', label: '-100 … -90' }, // 🌱 приемлемый
    { from: -110, to: -100, color: '#f0a83c', label: '-110 … -100' }, // 🟠 слабый
    { from: -118, to: -110, color: '#f03232', label: '-118 … -110' }, // 🔴 очень слабый
    { from: -200, to: -118, color: '#101010', label: '-200 … -118' }, // ⚫ на грани обрыва
  ],
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
