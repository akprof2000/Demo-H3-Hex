import type { StyleSpecification } from 'maplibre-gl';

/**
 * Минимальный растровый стиль OpenStreetMap. Тайлы OSM подходят для разработки
 * и небольшого трафика; в проде подставьте своего провайдера через prop `mapStyle`.
 */
export function osmStyle(
  tiles: string[] = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  attribution = '© OpenStreetMap contributors'
): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: { type: 'raster', tiles, tileSize: 256, maxzoom: 19, attribution },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } },
      { id: 'osm', type: 'raster', source: 'osm' },
    ],
  };
}
