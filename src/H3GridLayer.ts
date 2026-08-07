// 🖼️ WebGL-слой MapLibre, рисующий сетку гексагонов одними линиями.
//
// Это «облегчённый брат» `H3HexLayer`: заливки нет вообще, поэтому нет ни
// цветов вершин, ни индексного буфера — только вершины отрезков и один цвет
// на весь слой. Вся сетка экрана уходит в GPU за один вызов отрисовки. 🚀
import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl';
import { buildOutline } from './geometry';
import { EMPTY_GRID, type GridMesh } from './gridGeometry';

// ➖ Вершинный шейдер: единственная задача — спроецировать точку матрицей MapLibre
const LINE_VERT = `
precision highp float;
attribute vec2 a_pos;   // 📍 координата вершины (mercator, относительно origin)
uniform mat4 u_matrix;  // 🧮 матрица проекции, приходит от MapLibre каждый кадр
void main() { gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); }`;

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
  private posBuf: WebGLBuffer | null = null; // ➖ вершины отрезков сетки
  private hlBuf: WebGLBuffer | null = null; // ✨ контур выделенной ячейки
  private hlVerts = 0; // 🔢 вершин в контуре выделения
  private hlPending: Float32Array | null = null; // ⏳ контур, ждущий загрузки в буфер
  private hlCell: string | null = null; // 📌 какая ячейка сейчас подсвечена
  private mesh: GridMesh = EMPTY_GRID; // 📦 текущая сетка
  private pending: GridMesh | null = null; // ⏳ сетка, пришедшая до готовности GL
  private color: [number, number, number, number];
  private highlightColor: [number, number, number, number];

  constructor(id = 'h3-grid', opts: GridLayerOptions = {}) {
    this.id = id;
    this.color = opts.color ?? [1, 1, 1, 0.35]; // ⚪ полупрозрачная белая сетка
    this.highlightColor = opts.highlightColor ?? [1, 0.85, 0.2, 1]; // 🟡 яркое выделение
  }

  /** 🎨 Сменить цвет сетки на лету — без перестроения геометрии. */
  setColor(color: [number, number, number, number]) {
    this.color = color;
    this.map?.triggerRepaint(); // 🔄 просим MapLibre нарисовать новый кадр
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
    this.program = compile(gl, LINE_VERT, LINE_FRAG);
    this.posBuf = gl.createBuffer();
    this.hlBuf = gl.createBuffer();
    if (this.pending) this.upload(this.pending); // ⏳ сетка пришла раньше GL — грузим сейчас
  }

  // 🧹 Уборка: без неё буферы и программа утекут при пересоздании карты
  onRemove(_map: MlMap, gl: WebGLRenderingContext) {
    if (this.posBuf) gl.deleteBuffer(this.posBuf);
    if (this.hlBuf) gl.deleteBuffer(this.hlBuf);
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
      this.hlPending = null;
      this.hlVerts = 0;
    } else {
      // 📐 Контур считаем относительно того же origin, что и вся сетка,
      // иначе он «уедет» от неё ровно на величину origin.
      const verts = buildOutline(h3, this.mesh.origin);
      this.hlPending = verts;
      this.hlVerts = verts.length / 2;
    }
    this.map?.triggerRepaint();
  }

  /** ⬆️ Загрузка вершин в видеопамять. Происходит только при смене сетки. */
  private upload(mesh: GridMesh) {
    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    // 🔁 DYNAMIC_DRAW: сетка перестраивается на каждое движение карты,
    // драйверу полезно знать, что буфер недолговечен.
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    this.pending = null;
  }

  // 🎬 Вызывается MapLibre на каждый кадр — здесь всё должно быть максимально дёшево
  render(gl: WebGLRenderingContext, args: unknown) {
    if (this.mesh.vertexCount === 0 && this.hlVerts === 0) return; // 🚪 рисовать нечего

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

    const uMatrix = gl.getUniformLocation(this.program!, 'u_matrix');
    const uColor = gl.getUniformLocation(this.program!, 'u_color');
    const aPos = gl.getAttribLocation(this.program!, 'a_pos');
    gl.uniformMatrix4fv(uMatrix, false, matrix);
    gl.enableVertexAttribArray(aPos);

    // 🕸️ Сама сетка: один вызов на все линии экрана
    if (this.mesh.vertexCount > 0) {
      gl.uniform4fv(uColor, this.color);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, this.mesh.vertexCount);
    }

    // ✨ Контур выделенной ячейки — поверх сетки
    if (this.hlVerts > 0) {
      if (this.hlPending) {
        // ⬆️ Догружаем лениво, прямо в кадре: контур крошечный, это дёшево
        gl.bindBuffer(gl.ARRAY_BUFFER, this.hlBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this.hlPending, gl.DYNAMIC_DRAW);
        this.hlPending = null;
      }
      gl.uniform4fv(uColor, this.highlightColor);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hlBuf);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINE_LOOP, 0, this.hlVerts); // 🔁 замкнутая ломаная
    }
  }
}
