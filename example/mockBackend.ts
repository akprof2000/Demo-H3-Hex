import { cellToLatLng, polygonToCells } from 'h3-js';
import type { H3Cell, Viewport } from 'react-h3-map';

/** Мягкий «рельеф» вокруг центра Москвы + пара локальных пиков. */
function value(lat: number, lng: number): number {
  const dx = (lng - 37.6173) * Math.cos(lat * (Math.PI / 180));
  const dy = lat - 55.7558;
  const r = Math.hypot(dx, dy);
  const base = 100 * Math.exp(-(r * r) / 0.02);
  const ripples = 18 * Math.sin(dx * 90) * Math.cos(dy * 110);
  const peak = 45 * Math.exp(-((dx - 0.12) ** 2 + (dy + 0.06) ** 2) / 0.0012);
  return Math.max(0, base + ripples + peak);
}

const MAX_CELLS = 120_000;

/** Имитация HTTP-эндпоинта: отдаёт [[h3, value], ...] для видимой области. */
/** Фиксированный диапазон — иначе цвета «прыгают» при смене вьюпорта. */
export const DOMAIN: [number, number] = [0, 130];

export async function fetchHexes(vp: Viewport, signal: AbortSignal): Promise<H3Cell[]> {
  const [w, s, e, n] = vp.bbox;
  // Небольшой запас за краями экрана, чтобы при панораме не мигали пустые поля.
  const padX = (e - w) * 0.15;
  const padY = (n - s) * 0.15;
  const poly: number[][] = [
    [s - padY, w - padX],
    [s - padY, e + padX],
    [n + padY, e + padX],
    [n + padY, w - padX],
  ];

  let res = vp.resolution;
  let cells = polygonToCells(poly, res);
  while (cells.length > MAX_CELLS && res > 6) {
    cells = polygonToCells(poly, --res);
  }

  // Сетевая задержка, чтобы было видно работу дебаунса и отмены запросов.
  await new Promise((r) => setTimeout(r, 120));
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');

  const out: H3Cell[] = new Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const [lat, lng] = cellToLatLng(cells[i]);
    out[i] = [cells[i], Math.round(value(lat, lng) * 10) / 10];
  }
  return out;
}
