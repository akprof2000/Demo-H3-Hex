// 🖼️ WebGL-слой MapLibre: рисует все гексагоны за один вызов отрисовки.
// MapLibre разрешает вставить в свой конвейер «чужой» слой (CustomLayerInterface):
// он даёт нам готовый GL-контекст и матрицу проекции, остальное — наша забота. 🛠️
import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl';
import { buildMesh, buildOutline, type BuildOptions, type HexMesh } from './geometry';
import type { ColorScale } from './palette';
import type { H3Cell } from './types';

// 🟩 Вершинный шейдер заливки: перегоняет координаты в экранные и передаёт цвет дальше
const VERT = `
precision highp float;
attribute vec2 a_pos;     // 📍 координата вершины (mercator, относительно origin)
attribute vec4 a_color;   // 🎨 цвет вершины (нормализованный из UNSIGNED_BYTE)
uniform mat4 u_matrix;    // 🧮 матрица проекции от MapLibre
varying vec4 v_color;     // ➡️ цвет во фрагментный шейдер
void main() {
  v_color = a_color;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

// 🟦 Фрагментный шейдер заливки: premultiplied alpha под blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
const FRAG = `
precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = vec4(v_color.rgb * v_color.a, v_color.a);
}`;

// ➖ Шейдеры линий проще: цвет один на весь вызов, поэтому он в uniform
const LINE_VERT = `
precision highp float;
attribute vec2 a_pos;
uniform mat4 u_matrix;
void main() { gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); }`;

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
    // 🚨 Ошибку компиляции важно не проглотить: иначе слой молча ничего не нарисует
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('h3-map shader: ' + gl.getShaderInfoLog(s));
    }
    gl.attachShader(p, s);
    gl.deleteShader(s); // 🧹 сам объект шейдера после привязки уже не нужен
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('h3-map program: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

/**
 * 🎯 M × translate(tx, ty, 0), посчитанное в двойной точности.
 *
 * Зачем: вершины хранятся относительно origin (иначе float32 не хватает точности
 * на зумах 15+ и гексагоны начинают «дрожать»). Обратный сдвиг вносим в матрицу,
 * пока числа ещё double — и только потом опускаем результат до float32. 🎚️
 */
function translated(m: ArrayLike<number>, tx: number, ty: number): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 12; i++) out[i] = m[i]; // 📋 первые три столбца не меняются
  for (let i = 0; i < 4; i++) {
    // 🧮 Последний столбец = col0·tx + col1·ty + col3
    out[12 + i] = m[i] * tx + m[4 + i] * ty + m[12 + i];
  }
  return out;
}

export interface HexLayerOptions {
  /** ✨ Цвет контура гексагона под курсором. */
  outlineColor?: [number, number, number, number];
  /** ➖ Цвет адаптивной обводки (режимы `all` / `boundary`). */
  strokeColor?: [number, number, number, number];
}

/**
 * 🗺️ Слой гексагонов. Обычно его создаёт компонент `H3Map`, но при желании
 * слой можно добавить и в свою карту руками: `map.addLayer(new H3HexLayer())`.
 */
export class H3HexLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const; // 🏷️ обязательное поле контракта MapLibre
  readonly renderingMode = '2d' as const; // 🧭 плоский слой, без 3D-глубины

  private map: MlMap | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null; // 🟩 программа заливки
  private lineProgram: WebGLProgram | null = null; // ➖ программа линий
  private posBuf: WebGLBuffer | null = null; // 📍 вершины заливки
  private colorBuf: WebGLBuffer | null = null; // 🎨 цвета вершин
  private idxBuf: WebGLBuffer | null = null; // 🔺 индексы треугольников
  private edgeBuf: WebGLBuffer | null = null; // ➖ индексы рёбер (режим `all`)
  private edgePosBuf: WebGLBuffer | null = null; // ➖ вершины линий (режим `boundary`)
  private outlineBuf: WebGLBuffer | null = null; // ✨ контур гекса под курсором
  private edgeCount = 0; // 🔢 сколько индексов рёбер рисовать
  private edgeVertCount = 0; // 🔢 сколько вершин линий рисовать
  private outlineVerts = 0;
  private strokeColor: [number, number, number, number];
  private outlineColor: [number, number, number, number];
  private mesh: HexMesh | null = null; // 📦 текущие данные
  private pending: HexMesh | null = null; // ⏳ данные, пришедшие до инициализации GL
  private outlinePending: Float32Array | null = null; // ⏳ контур, ждущий загрузки в буфер

  constructor(id = 'h3-hexagons', opts: HexLayerOptions = {}) {
    this.id = id;
    this.outlineColor = opts.outlineColor ?? [1, 1, 1, 0.95]; // ⚪ белый контур наведения
    this.strokeColor = opts.strokeColor ?? [0, 0, 0, 0.35]; // ⚫ полупрозрачная сетка
  }

  /** 🖊️ Сменить цвет обводки на лету. */
  setStrokeColor(color: [number, number, number, number]) {
    this.strokeColor = color;
    this.map?.triggerRepaint(); // 🔄 просим MapLibre перерисовать кадр
  }

  /** 🔍 Карта h3 → значение (нужна пикингу в компоненте). */
  get lookup(): Map<string, number> {
    return this.mesh?.lookup ?? new Map();
  }
  /** 📏 Разрешения H3 в текущих данных. */
  get resolutions(): number[] {
    return this.mesh?.resolutions ?? [];
  }

  // 🚪 MapLibre зовёт onAdd, когда слой добавлен в карту и GL-контекст готов
  onAdd(map: MlMap, gl: WebGLRenderingContext) {
    this.map = map;
    this.gl = gl;
    // 🔢 32-битные индексы: в WebGL1 это расширение, в WebGL2 — часть стандарта
    if (!(gl instanceof WebGL2RenderingContext)) {
      gl.getExtension('OES_element_index_uint');
    }
    this.program = compile(gl, VERT, FRAG);
    this.lineProgram = compile(gl, LINE_VERT, LINE_FRAG);
    this.posBuf = gl.createBuffer();
    this.colorBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.edgeBuf = gl.createBuffer();
    this.edgePosBuf = gl.createBuffer();
    this.outlineBuf = gl.createBuffer();
    if (this.pending) this.upload(this.pending); // ⏳ данные пришли раньше GL — грузим сейчас
  }

  // 🧹 Уборка: без неё буферы и программы утекут при пересоздании карты
  onRemove(_map: MlMap, gl: WebGLRenderingContext) {
    const buffers = [
      this.posBuf,
      this.colorBuf,
      this.idxBuf,
      this.edgeBuf,
      this.edgePosBuf,
      this.outlineBuf,
    ];
    for (const b of buffers) {
      if (b) gl.deleteBuffer(b);
    }
    if (this.program) gl.deleteProgram(this.program);
    if (this.lineProgram) gl.deleteProgram(this.lineProgram);
    this.gl = null;
    this.map = null;
  }

  /** 📥 Полная замена данных: геометрия строится здесь же, синхронно. */
  setData(cells: readonly H3Cell[], scale: ColorScale, opts?: BuildOptions) {
    this.setMesh(buildMesh(cells, scale, opts));
  }

  /** 📦 Готовый меш — например, собранный в Web Worker. */
  setMesh(mesh: HexMesh) {
    if (this.gl) this.upload(mesh);
    else this.pending = mesh; // ⏳ GL ещё не готов — положим в очередь
    this.mesh = mesh;
    this.map?.triggerRepaint();
  }

  /** ✨ Подсветить гексагон (или снять подсветку, передав null). */
  setHighlight(h3: string | null) {
    if (!h3 || !this.mesh) {
      this.outlinePending = null;
      this.outlineVerts = 0;
    } else {
      // 📐 Контур считаем относительно того же origin, что и весь меш
      const verts = buildOutline(h3, this.mesh.origin);
      this.outlinePending = verts;
      this.outlineVerts = verts.length / 2;
    }
    this.map?.triggerRepaint();
  }

  /** ⬆️ Загрузка буферов в видеопамять. Происходит только при смене данных. */
  private upload(mesh: HexMesh) {
    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW); // 📍 позиции
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW); // 🎨 цвета
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW); // 🔺 треугольники

    // ➖ Режим `all` переиспользует вершины заливки (нужны только индексы),
    // режим `boundary` приносит собственные вершины линий.
    this.edgeCount = mesh.edgeIndices.length;
    this.edgeVertCount = mesh.edgePositions.length / 2;
    if (this.edgeCount > 0) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.edgeIndices, gl.STATIC_DRAW);
    } else if (this.edgeVertCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgePosBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.edgePositions, gl.STATIC_DRAW);
    }
    this.pending = null;
  }

  // 🎬 Вызывается MapLibre на каждый кадр — здесь должно быть максимально дёшево
  render(gl: WebGLRenderingContext, args: unknown) {
    const mesh = this.mesh;
    if (!mesh || mesh.vertexCount === 0) return; // 🚪 рисовать нечего

    // 🔀 Совместимость версий: MapLibre v4 передаёт саму матрицу,
    // v5 — объект с defaultProjectionData.mainMatrix.
    const raw =
      Array.isArray(args) || ArrayBuffer.isView(args)
        ? (args as ArrayLike<number>)
        : ((args as any)?.defaultProjectionData?.mainMatrix as ArrayLike<number>);
    if (!raw) return;
    const matrix = translated(raw, mesh.origin[0], mesh.origin[1]); // 🎯 возвращаем origin

    gl.useProgram(this.program);
    gl.enable(gl.BLEND); // 👻 включаем прозрачность
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // 🧪 premultiplied alpha
    gl.disable(gl.DEPTH_TEST); // 🧭 плоский слой — глубина только мешает

    gl.uniformMatrix4fv(gl.getUniformLocation(this.program!, 'u_matrix'), false, matrix);

    // 📍 Привязка атрибута позиций
    const aPos = gl.getAttribLocation(this.program!, 'a_pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // 🎨 Цвета: UNSIGNED_BYTE + normalized=true, GPU сам переведёт 0..255 → 0..1
    const aCol = gl.getAttribLocation(this.program!, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // 🚀 Вот он — один-единственный вызов отрисовки на все гексагоны
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.drawElements(gl.TRIANGLES, mesh.vertexCount, gl.UNSIGNED_INT, 0);
    gl.disableVertexAttribArray(aCol); // 🧹 чтобы не мешать следующим слоям карты

    // ➖ Обводка: индексы поверх вершин заливки либо собственные вершины линий
    if (this.edgeCount > 0 || this.edgeVertCount > 0) {
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram!, 'u_matrix'), false, matrix);
      gl.uniform4fv(gl.getUniformLocation(this.lineProgram!, 'u_color'), this.strokeColor);
      const sPos = gl.getAttribLocation(this.lineProgram!, 'a_pos');
      gl.enableVertexAttribArray(sPos);
      if (this.edgeCount > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf); // ♻️ те же вершины, что у заливки
        gl.vertexAttribPointer(sPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeBuf);
        gl.drawElements(gl.LINES, this.edgeCount, gl.UNSIGNED_INT, 0);
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.edgePosBuf);
        gl.vertexAttribPointer(sPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, this.edgeVertCount);
      }
    }

    // ✨ Контур гексагона под курсором — поверх всего остального
    if (this.outlineVerts > 0) {
      if (this.outlinePending) {
        // ⬆️ Догружаем контур лениво, уже внутри кадра: он крошечный
        gl.bindBuffer(gl.ARRAY_BUFFER, this.outlineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this.outlinePending, gl.DYNAMIC_DRAW);
        this.outlinePending = null;
      }
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram!, 'u_matrix'), false, matrix);
      gl.uniform4fv(gl.getUniformLocation(this.lineProgram!, 'u_color'), this.outlineColor);
      const lPos = gl.getAttribLocation(this.lineProgram!, 'a_pos');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.outlineBuf);
      gl.enableVertexAttribArray(lPos);
      gl.vertexAttribPointer(lPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINE_LOOP, 0, this.outlineVerts); // 🔁 замкнутая ломаная
    }
  }
}
