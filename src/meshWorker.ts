// 🧵 Фоновый поток: считает геометрию, пока интерфейс остаётся отзывчивым.
// Здесь нельзя трогать DOM — только чистые вычисления. 🚫🖥️
/// <reference lib="webworker" />
import { buildMesh, type EdgeMode } from './geometry';
import { ColorScale } from './palette';
import type { H3Cell, Palette } from './types';

/** 📥 Что прилетает в воркер. */
export interface MeshRequest {
  id: number; // 🎫 номер запроса, чтобы отсеять устаревшие ответы
  cells: H3Cell[];
  palette: Palette;
  domain: [number, number];
  edges: EdgeMode;
}

/** 📤 Что уходит обратно: только буферы, они передаются без копирования. */
export interface MeshResponse {
  id: number;
  positions: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  edgeIndices: Uint32Array;
  edgePositions: Float32Array;
  origin: [number, number];
  vertexCount: number;
}

/**
 * Строит буферы вне главного потока. Карта h3 -> value обратно не отправляется:
 * на главном потоке она собирается из тех же cells дешевле, чем клонируется.
 */
self.onmessage = (e: MessageEvent<MeshRequest>) => {
  const { id, cells, palette, domain, edges } = e.data;
  const mesh = buildMesh(cells, new ColorScale(palette, domain), { edges }); // 🏗️ вся работа тут

  // ✂️ slice() уплотняет subarray в собственный буфер: иначе transfer утащил бы
  // весь аллокат «с запасом», а это в разы больше памяти.
  const res: MeshResponse = {
    id,
    positions: mesh.positions.slice(),
    colors: mesh.colors.slice(),
    indices: mesh.indices.slice(),
    edgeIndices: mesh.edgeIndices.slice(),
    edgePositions: mesh.edgePositions.slice(),
    origin: mesh.origin,
    vertexCount: mesh.vertexCount,
  };
  // 🚚 Второй аргумент — список transferables: буферы «переезжают», а не копируются
  (self as unknown as Worker).postMessage(res, [
    res.positions.buffer,
    res.colors.buffer,
    res.indices.buffer,
    res.edgeIndices.buffer,
    res.edgePositions.buffer,
  ]);
};
