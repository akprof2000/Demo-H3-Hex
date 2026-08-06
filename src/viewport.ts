// 🔭 Подгрузка данных по видимой области карты.
// Задача: не завалить бэкенд запросами при панораме и не показать устаревший ответ. 🧯
import { useEffect, useRef, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import type { H3Cell, Viewport } from './types';

/**
 * 📏 Соответствие зума и разрешения H3 по умолчанию.
 *
 * Подобрано так, чтобы гексагоны были мелкими и их помещалось на экран много.
 * Каждый шаг разрешения — ребро в ~2.6 раза меньше и в 7 раз больше ячеек.
 * Не нравится — передайте свою функцию в проп `resolutionForZoom`. 🔧
 */
export function resolutionForZoom(zoom: number): number {
  const r = Math.round(zoom * 0.8 - 1);
  return r < 0 ? 0 : r > 12 ? 12 : r; // ✂️ H3 знает разрешения 0..15
}

/** 📦 Снимок текущего вида карты — именно он уходит в бэкенд. */
export function viewportOf(map: MlMap, resolution: (z: number) => number): Viewport {
  const b = map.getBounds(); // 🖼️ границы видимой области
  const zoom = map.getZoom();
  return {
    bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    zoom,
    resolution: resolution(zoom),
  };
}

/**
 * 📨 Ответ бэкенда: либо просто ячейки, либо ячейки с фиксированным диапазоном.
 * Второй вариант удобнее: цвета не «прыгают» при смене вьюпорта. 🔒
 */
export type FetchResult = H3Cell[] | { cells: H3Cell[]; domain?: [number, number] };

export type Fetcher = (vp: Viewport, signal: AbortSignal) => Promise<FetchResult>;

/**
 * 🪝 Хук подгрузки по вьюпорту. Три защиты сразу:
 * 1. ⏱️ дебаунс — не дёргаем бэкенд на каждый пиксель панорамы;
 * 2. 🛑 AbortSignal — предыдущий запрос отменяется;
 * 3. 🔢 номер запроса — ответ, пришедший не по порядку, отбрасывается.
 */
export function useViewportData(
  map: MlMap | null,
  fetcher: Fetcher | undefined,
  opts: { debounceMs?: number; resolutionForZoom?: (z: number) => number } = {}
) {
  const { debounceMs = 200 } = opts;
  const resFn = opts.resolutionForZoom ?? resolutionForZoom;
  const [data, setData] = useState<H3Cell[] | null>(null);
  const [domain, setDomain] = useState<[number, number] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0); // 🔢 счётчик запросов: актуален только последний
  const fetcherRef = useRef(fetcher); // 📌 свежая ссылка без переподписки на события
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!map || !fetcher) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;

    const run = () => {
      ctrl?.abort(); // 🛑 обрываем предыдущий запрос
      ctrl = new AbortController();
      const my = ++seq.current; // 🎫 «номерок» этого запроса
      setLoading(true);
      fetcherRef
        .current!(viewportOf(map, resFn), ctrl.signal)
        .then((result) => {
          if (my !== seq.current) return; // 🕰️ ответ устарел — молча выходим
          if (Array.isArray(result)) {
            setData(result); // 📊 простой формат
          } else {
            setData(result.cells);
            if (result.domain) setDomain(result.domain); // 🔒 фиксированный диапазон
          }
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          // 🤫 Отмена — это не ошибка, показывать её пользователю не нужно
          if (my !== seq.current || e?.name === 'AbortError') return;
          setError(e);
          setLoading(false);
        });
    };

    // ⏱️ Дебаунс: перезапускаем таймер на каждое движение карты
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
    };

    run(); // 🚀 первый запрос — сразу, без ожидания
    map.on('moveend', schedule);
    map.on('zoomend', schedule);
    return () => {
      clearTimeout(timer);
      ctrl?.abort();
      seq.current++; // 🚧 инвалидируем всё, что ещё в полёте
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, !!fetcher, debounceMs]);

  return { data, domain, loading, error };
}
