export { H3Map, type H3MapProps } from './H3Map';
export { H3HexLayer, type HexLayerOptions } from './H3HexLayer';
// 🕸️ Сетка гексагонов на весь экран — компонент, слой и его геометрия
export { H3Grid, type H3GridProps, type GridInfo } from './H3Grid';
export { H3GridLayer, type GridLayerOptions } from './H3GridLayer';
export {
  buildGridMesh,
  cellsForBBox,
  estimateCellCount,
  padBBox,
  resolutionForEdgePixels,
  type BBox,
  type GridMesh,
} from './gridGeometry';
export { Legend, type LegendProps } from './Legend';
export { ColorScale, DEFAULT_PALETTE, RSRP_PALETTE, domainOf } from './palette';
export { osmStyle } from './mapStyle';
export {
  useViewportData,
  resolutionForZoom,
  viewportOf,
  type Fetcher,
  type FetchResult,
} from './viewport';
export { MeshBuilder } from './meshClient';
export {
  buildMesh,
  buildOutline,
  edgeModeForView,
  edgePixels,
  EDGE_THRESHOLDS,
  type BuildOptions,
  type EdgeMode,
  type HexMesh,
} from './geometry';
export type { H3Cell, HoverInfo, Palette, PaletteBin, RGBA, Viewport } from './types';
