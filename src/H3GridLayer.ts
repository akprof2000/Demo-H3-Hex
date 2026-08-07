// 🖼️ WebGL-слой MapLibre, рисующий сетку гексагонов линиями заданной толщины.
//
// Это «облегчённый брат» `H3HexLayer`: заливки нет, цвет один на весь слой.
// Вся сетка экрана уходит в GPU за один вызов отрисовки. 🚀
import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl';
import { buildOutline } from './geometry';
import {
  EMPTY_GRID,
  EMPTY_LINES,
  expandSegments,
  loopToSegments,
  type GridMesh,
  type LineMesh,
} from './gridGeometry';

/**
 * ➖ Вершинный шейдер: проецирует точку и раздвигает отрезок в прямоугольник.
 *
 * Толщина задаётся в ПИКСЕЛЯХ, а не в градусах, поэтому смещение считается уже
 * после проекции: обе точки отрезка переводятся в экранные координаты, там
 * берётся перпендикуляр к направлению, и вершина уезжает на половину толщины.
 * Так линия остаётся одинаковой на любом зуме и не «толстеет» при приближении.
 */
const LINE_VERT = `
precision highp float;
attribute vec2 a_pos;     // 📍 своя точка отрезка (mercator, относительно origin)
attribute vec2 a_other;   // 👉 второй конец того же отрезка
attribute float a_side;   // ↔️ в какую сторону от оси смещаться: +1 или −1
uniform mat4 u_matrix;    // 🧮 матрица проекции, приходит от MapLibre каждый кадр
uniform vec2 u_viewport;  // 🖥️ размеры буфера кадра в пикселях устройства
uniform float u_width;    // 📏 толщина линии в тех же пикселях
void main() {
  vec4 c0 = u_matrix * vec4(a_pos, 0.0, 1.0);   // своя точка в clip-space
  vec4 c1 = u_matrix * vec4(a_other, 0.0, 1.0); // соседняя — только ради направления

  // 🖥️ Перевод в экранные пропорции: делим на w (перспектива) и умножаем на
  // размеры вьюпорта. Общий множитель не важен — нужно только НАПРАВЛЕНИЕ.
  vec2 s0 = c0.xy / c0.w * u_viewport;
  vec2 s1 = c1.xy / c1.w * u_viewport;

  vec2 dir = s1 - s0;
  float len = length(dir);
  // 🛡️ Вырожденный отрезок (обе точки совпали) дал бы деление на ноль
  vec2 n = len > 0.0 ? vec2(-dir.y, dir.x) / len : vec2(0.0);

  // 🧮 Обратный перевод пикселей в clip-space: NDC = clip/w, а пиксели = NDC·вьюпорт/2,
  // поэтому пиксель → clip это ·2/вьюпорт·w. Половина толщины: ·0.5. Итого /u_viewport·w.
  vec2 offset = n * a_side * u_width / u_viewport * c0.w;
  gl_Position = vec4(c0.xy + offset, c0.z, c0.w);
}`;

// 🟦 Фрагментный шейдер: цвет один на весь вызов, поэтому лежит в uniform.
// Умножение на альфу — требование premultiplied alpha (см. blendFunc ниже).
const LINE_FRAG = `
precision mediump float;
uniform vec4 u_color;
void main() { gl_FragColor = vec4(u_color.rgb * u_color.a, u_color.a); }`;

/** 🔧 Компиляция и линковка пары шейдеров в программу. */
function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    // 🚨 Молчаливая ошибка компиляции = пустой экран без единого сообщения
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('h3-grid shader: ' + gl.getShaderInfoLog(s));
    }
    gl.attachShader(p, s);
    gl.deleteShader(s); // 🧹 после привязки объект шейдера больше не нужен
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('h3-grid program: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

/**
 * 🎯 M × translate(tx, ty, 0), посчитанное в двойной точности.
 *
 * Вершины хранятся относительно origin, а обратный сдвиг мы вносим в матрицу,
 * пока числа ещё double. Если сдвигать вершины, точности float32 не хватит. 🎚️
 */
function translated(m: ArrayLike<number>, tx: number, ty: number): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 12; i++) out[i] = m[i]; // 📋 первые три столбца не меняются
  for (let i = 0; i < 4; i++) {
    out[12 + i] = m[i] * tx + m[4 + i] * ty + m[12 + i]; // 🧮 col0·tx + col1·ty + col3
  }
  return out;
}

export interface GridLayerOptions {
  /** 🎨 Цвет линий сетки: [r, g, b, a] в диапазоне 0..1. */
  color?: [number, number, number, number];
  /** ✨ Цвет контура выделенного гексагона. */
  highlightColor?: [number, number, number, number];
  /** 📏 Толщина линий сетки в CSS-пикселях. По умолчанию 2. */
  width?: number;
  /** 📏 Толщина контура выделения. По умолчанию на пиксель толще сетки. */
  highlightWidth?: number;
}

/**
 * 🎒 Четыре буфера одного набора линий: позиции, вторые концы, стороны и индексы.
 * Вынесено в отдельный класс, потому что таких наборов два — сетка и подсветка,
 * и логика загрузки у них полностью одинаковая. ♻️
 */
class LineBuffers {
  pos: WebGLBuffer | null = null;
  other: WebGLBuffer | null = null;
  side: WebGLBuffer | null = null;
  index: WebGLBuffer | null = null;
  count = 0; // 🔢 сколько индексов рисовать

  create(gl: WebGLRenderingContext) {
    this.pos = gl.createBuffer();
    this.other = gl.createBuffer();
    this.side = gl.createBuffer();
    this.index = gl.createBuffer();
  }

  /** ⬆️ Загрузка всех четырёх буферов в видеопамять. */
  upload(gl: WebGLRenderingContext, mesh: LineMesh) {
    // 🔁 DYNAMIC_DRAW: буферы перестраиваются на каждое движение карты,
    // драйверу полезно знать, что они недолговечны.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.other);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.others, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.side);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.sides, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    this.count = mesh.indexCount;
  }

  /** 🔗 Привязка атрибутов и сам вызов отрисовки. */
  draw(gl: WebGLRenderingContext, aPos: number, aOther: number, aSide: number) {
    if (this.count === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.other);
    gl.vertexAttribPointer(aOther, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.side);
    gl.vertexAttribPointer(aSide, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
  }

  destroy(gl: WebGLRenderingContext) {
    for (const b of [this.pos, this.other, this.side, this.index]) {
      if (b) gl.deleteBuffer(b);
    }
  }
}

/**
 * 🕸️ Слой сетки. Обычно его создаёт компонент `H3Grid`, но слой самодостаточен
 * и его можно добавить в свою карту руками: `map.addLayer(new H3GridLayer())`.
 */
export class H3GridLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const; // 🏷️ обязательные поля контракта MapLibre
  readonly renderingMode = '2d' as const;

  private map: MlMap | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private grid = new LineBuffers(); // 🕸️ буферы самой сетки
  private hl = new LineBuffers(); // ✨ буферы контура выделения
  private hlPending: LineMesh | null = null; // ⏳ контур, ждущий загрузки в буфер
  private hlCell: string | null = null; // 📌 какая ячейка сейчас подсвечена
  private mesh: GridMesh = EMPTY_GRID; // 📦 текущая сетка
  private pending: GridMesh | null = null; // ⏳ сетка, пришедшая до готовности GL
  private color: [number, number, number, number];
  private highlightColor: [number, number, number, number];
  private width: number;
  private highlightWidth: number;

  constructor(id = 'h3-grid', opts: GridLayerOptions = {}) {
    this.id = id;
    // ⚫ По умолчанию сетка чёрная: на растровых тайлах OSM (светлые дома, серые
    // дороги) тёмная линия читается лучше белой. Для тёмной подложки передайте
    // светлый цвет — например, `color="#ffffff59"`.
    this.color = opts.color ?? [0, 0, 0, 0.45];
    this.highlightColor = opts.highlightColor ?? [1, 0.85, 0.2, 1]; // 🟡 яркое выделение
    this.width = opts.width ?? 2; // 📏 две трети толщины дороги на тайле OSM
    this.highlightWidth = opts.highlightWidth ?? this.width + 1;
  }

  /** 🎨 Сменить цвет сетки на лету — без перестроения геометрии. */
  setColor(color: [number, number, number, number]) {
    this.color = color;
    this.map?.triggerRepaint(); // 🔄 просим MapLibre нарисовать новый кадр
  }

  /**
   * 📏 Сменить толщину линий (в CSS-пикселях).
   *
   * Геометрия при этом НЕ перестраивается: толщина живёт в uniform, а вершины
   * раздвигаются шейдером уже на GPU. Поэтому ползунок толщины в интерфейсе
   * стоит ровно один кадр, сколько бы гексагонов ни было на экране. ⚡
   */
  setWidth(width: number, highlightWidth = width + 1) {
    this.width = width;
    this.highlightWidth = highlightWidth;
    this.map?.triggerRepaint();
  }

  /** ✨ Сменить цвет контура выделения. */
  setHighlightColor(color: [number, number, number, number]) {
    this.highlightColor = color;
    this.map?.triggerRepaint();
  }

  /** 🧱 Ячейки текущей сетки (нужны компоненту для статистики). */
  get cells(): string[] {
    return this.mesh.cells;
  }

  // 🚪 MapLibre зовёт onAdd, когда слой добавлен и GL-контекст уже готов
  onAdd(map: MlMap, gl: WebGLRenderingContext) {
    this.map = map;
    this.gl = gl;
    // 🔢 32-битные индексы: в WebGL1 это расширение, в WebGL2 — часть стандарта.
    // Без него сетка крупнее ~16 тысяч вершин отрисуется мусором.
    if (!(gl instanceof WebGL2RenderingContext)) {
      gl.getExtension('OES_element_index_uint');
    }
    this.program = compile(gl, LINE_VERT, LINE_FRAG);
    this.grid.create(gl);
    this.hl.create(gl);
    if (this.pending) this.upload(this.pending); // ⏳ сетка пришла раньше GL — грузим сейчас
  }

  // 🧹 Уборка: без неё буферы и программа утекут при пересоздании карты
  onRemove(_map: MlMap, gl: WebGLRenderingContext) {
    this.grid.destroy(gl);
    this.hl.destroy(gl);
    if (this.program) gl.deleteProgram(this.program);
    this.gl = null;
    this.map = null;
  }

  /** 📥 Полная замена сетки. */
  setMesh(mesh: GridMesh) {
    if (this.gl) this.upload(mesh);
    else this.pending = mesh; // ⏳ GL ещё не готов — встанем в очередь
    this.mesh = mesh;
    // ♻️ У новой сетки свой origin, а контур выделения считался относительно
    // старого — пересчитываем, иначе подсветка «уедет» от гексагона.
    if (this.hlCell) this.setHighlight(this.hlCell);
    this.map?.triggerRepaint();
  }

  /** ✨ Подсветить ячейку (или снять подсветку, передав null). */
  setHighlight(h3: string | null) {
    this.hlCell = h3;
    if (!h3) {
      this.hlPending = EMPTY_LINES;
      this.hl.count = 0;
    } else {
      // 📐 Контур считаем относительно того же origin, что и вся сетка,
      // иначе он «уедет» от неё ровно на величину origin.
      // 🔁 Замкнутая ломаная → отрезки → прямоугольники: подсветка должна быть
      // такой же толстой, как сетка, а `gl.LINE_LOOP` этого не умеет.
      this.hlPending = expandSegments(loopToSegments(buildOutline(h3, this.mesh.origin)));
    }
    this.map?.triggerRepaint();
  }

  /** ⬆️ Загрузка вершин в видеопамять. Происходит только при смене сетки. */
  private upload(mesh: GridMesh) {
    this.grid.upload(this.gl!, mesh);
    this.pending = null;
  }

  // 🎬 Вызывается MapLibre на каждый кадр — здесь всё должно быть максимально дёшево
  render(gl: WebGLRenderingContext, args: unknown) {
    // 🚪 Рисовать нечего — и это не редкость: сетка пустая, пока не пришёл
    // первый расчёт или пока сработал предохранитель по числу ячеек.
    if (this.grid.count === 0 && this.hl.count === 0 && !this.hlPending) return;

    // 🔀 Совместимость версий: MapLibre v4 передаёт саму матрицу,
    // v5 — объект с defaultProjectionData.mainMatrix.
    const raw =
      Array.isArray(args) || ArrayBuffer.isView(args)
        ? (args as ArrayLike<number>)
        : ((args as any)?.defaultProjectionData?.mainMatrix as ArrayLike<number>);
    if (!raw) return;
    const matrix = translated(raw, this.mesh.origin[0], this.mesh.origin[1]); // 🎯 вернули origin

    gl.useProgram(this.program);
    gl.enable(gl.BLEND); // 👻 линии полупрозрачные
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // 🧪 premultiplied alpha
    gl.disable(gl.DEPTH_TEST); // 🧭 плоский слой — глубина только мешает
    // ✂️ Отсечение задних граней выключаем явно: у отрезка, идущего справа
    // налево, прямоугольник обходится в другую сторону и при включённом
    // отсечении просто исчезнет. Состояние GL общее на всю карту, и включить
    // его мог любой слой до нас.
    gl.disable(gl.CULL_FACE);

    const uColor = gl.getUniformLocation(this.program!, 'u_color');
    const uWidth = gl.getUniformLocation(this.program!, 'u_width');
    const aPos = gl.getAttribLocation(this.program!, 'a_pos');
    const aOther = gl.getAttribLocation(this.program!, 'a_other');
    const aSide = gl.getAttribLocation(this.program!, 'a_side');
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program!, 'u_matrix'), false, matrix);

    // 🖥️ Размеры буфера кадра — в пикселях УСТРОЙСТВА, а толщина задаётся в
    // CSS-пикселях. Отношение одного к другому и есть devicePixelRatio: без
    // него на ретине линия вышла бы вдвое тоньше заказанной.
    const canvas = gl.canvas as HTMLCanvasElement;
    const dpr = canvas.clientWidth ? gl.drawingBufferWidth / canvas.clientWidth : 1;
    gl.uniform2f(
      gl.getUniformLocation(this.program!, 'u_viewport'),
      gl.drawingBufferWidth,
      gl.drawingBufferHeight
    );

    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aOther);
    gl.enableVertexAttribArray(aSide);

    // 🕸️ Сама сетка: один вызов на все линии экрана
    gl.uniform4fv(uColor, this.color);
    gl.uniform1f(uWidth, this.width * dpr);
    this.grid.draw(gl, aPos, aOther, aSide);

    // ✨ Контур выделенной ячейки — поверх сетки и чуть толще её
    if (this.hlPending) {
      // ⬆️ Догружаем лениво, прямо в кадре: контур крошечный, это дёшево
      this.hl.upload(gl, this.hlPending);
      this.hlPending = null;
    }
    if (this.hl.count > 0) {
      gl.uniform4fv(uColor, this.highlightColor);
      gl.uniform1f(uWidth, this.highlightWidth * dpr);
      this.hl.draw(gl, aPos, aOther, aSide);
    }

    // 🧹 Отключаем атрибуты за собой: следующие слои карты пользуются теми же
    // слотами, и включённый лишний атрибут ломает их отрисовку.
    gl.disableVertexAttribArray(aOther);
    gl.disableVertexAttribArray(aSide);
  }
}
