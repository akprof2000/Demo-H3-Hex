// 🧵 Мост между главным потоком и Web Worker.
// Маленькие наборы считаются здесь же (переброс дороже работы), большие — в воркере. ⚖️
import { getResolution } from 'h3-js';
import { buildMesh, type BuildOptions, type HexMesh } from './geometry';
import { ColorScale } from './palette';
import type { MeshRequest, MeshResponse } from './meshWorker';
import type { H3Cell, Palette } from './types';

/**
 * 🔍 Строим карту h3 → значение на главном потоке.
 * Так дешевле, чем гонять готовый Map через structured clone из воркера. 📦
 */
function indexCells(cells: readonly H3Cell[]) {
  const lookup = new Map<string, number>();
  const resSet = new Set<number>();
  for (let i = 0; i < cells.length; i++) {
    lookup.set(cells[i][0], cells[i][1]);
    resSet.add(getResolution(cells[i][0])); // 📏 разрешение читается из самого индекса
  }
  return { lookup, resolutions: [...resSet].sort((a, b) => a - b) };
}

/**
 * 🏭 Сборщик меша. Один воркер, побеждает последний запрос: при быстром зуме
 * плодить воркеры бессмысленно — промежуточные кадры всё равно никто не увидит. 🏃
 */
export class MeshBuilder {
  private worker: Worker | null = null;
  private seq = 0; // 🔢 номер последнего запроса
  private waiting = new Map<number, (m: HexMesh) => void>(); // ⏳ кто ждёт ответа

  /**
   * @param threshold ниже этого числа гексов считаем синхронно
   * @param factory своя фабрика воркера; нужна в сборках, где путь к воркеру
   *   не резолвится автоматически (в Vite: `new Worker(new URL('react-h3-map/dist/meshWorker.js', import.meta.url), { type: 'module' })`)
   */
  constructor(
    private readonly threshold = 20_000,
    private readonly factory?: () => Worker
  ) {}

  /** 🧵 Ленивая инициализация воркера: создаём только когда он реально понадобился. */
  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null; // 🖥️ SSR или старый рантайм
    try {
      // ⚠️ Путь собирается из кусочков намеренно: иначе сборщики (Vite, webpack)
      // пытаются статически разрешить воркер прямо из исходников библиотеки и
      // падают. Для гарантированного результата передавайте `workerFactory`. 🏭
      const url = new URL(`./${'meshWorker'}.js`, import.meta.url);
      this.worker = this.factory ? this.factory() : new Worker(url, { type: 'module' });
      // 📬 Ответ воркера: буферы пришли по transfer, копирования не было
      this.worker.onmessage = (e: MessageEvent<MeshResponse>) => {
        const done = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        done?.({
          positions: e.data.positions,
          colors: e.data.colors,
          indices: e.data.indices,
          edgeIndices: e.data.edgeIndices,
          edgePositions: e.data.edgePositions,
          origin: e.data.origin,
          vertexCount: e.data.vertexCount,
          lookup: new Map(), // 🔍 подставим ниже, в build()
          resolutions: [],
        });
      };
    } catch {
      this.worker = null; // 🪂 сборка без module-воркеров — спокойно считаем на месте
    }
    return this.worker;
  }

  /**
   * 🏗️ Собрать меш. Возвращает либо готовый объект (синхронный путь),
   * либо промис (воркер) — вызывающий код проверяет `instanceof Promise`.
   *
   * ⚠️ Промис устаревшего запроса просто никогда не резолвится: это осознанно,
   * иначе пришлось бы гасить «отменённые» ошибки на каждом кадре зума.
   */
  build(
    cells: readonly H3Cell[],
    palette: Palette,
    domain: [number, number],
    opts: BuildOptions = {}
  ): HexMesh | Promise<HexMesh> {
    // ⚖️ Мало ячеек (или воркеры недоступны) — считаем прямо здесь
    const worker = cells.length < this.threshold ? null : this.ensure();
    // 💡 В синхронном пути buildMesh соберёт lookup сам, индексировать не нужно
    if (!worker) return buildMesh(cells, new ColorScale(palette, domain), opts);
    const index = indexCells(cells); // 🔍 а для воркера — собираем здесь

    const id = ++this.seq;
    this.waiting.clear(); // 🧹 предыдущие ожидания больше не актуальны
    const req: MeshRequest = {
      id,
      cells: cells as H3Cell[],
      palette,
      domain,
      edges: opts.edges ?? 'none',
    };
    worker.postMessage(req); // 📤 массив ячеек копируется, буферы вернутся transfer-ом
    return new Promise<HexMesh>((resolve) => {
      this.waiting.set(id, (mesh) => {
        if (id !== this.seq) return; // 🕰️ пока считали, пришёл более свежий запрос
        mesh.lookup = index.lookup; // 🔍 доклеиваем то, что считали на главном потоке
        mesh.resolutions = index.resolutions;
        resolve(mesh);
      });
    });
  }

  /** 🧹 Погасить воркер — вызывается при размонтировании компонента. */
  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
  }
}
