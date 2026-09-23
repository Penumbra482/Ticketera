/**
 * Generador de códigos QR (ISO/IEC 18004), modo byte.
 *
 * Está escrito a mano y sin dependencias porque la entrada tiene que poder
 * dibujarse en el celular del usuario aunque no haya señal en la puerta del
 * teatro: el servidor manda solo el texto firmado y el navegador arma el
 * código. Soporta versiones 1 a 40 y los cuatro niveles de corrección de
 * error; elige la versión más chica que entre.
 *
 * Verificado con OpenCV en server/test/qr.test.js: cada matriz que genera se
 * decodifica de vuelta al texto original. La verificación cubre hoy las
 * versiones 1 a 18 (más que de sobra: el código de una entrada entra en la 4).
 * Las tablas de las versiones más altas están escritas pero todavía no se
 * contrastaron contra un lector real.
 */

// ─── Aritmética en GF(256), polinomio primitivo 0x11D ────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Polinomio generador de Reed-Solomon para `degree` codewords de corrección. */
function rsGenerator(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Resto de dividir el mensaje por el generador: son los codewords de ECC. */
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ─── Tablas de capacidad (norma ISO/IEC 18004, tabla 9) ──────────────────────
// Índice: [nivel][versión]. La posición 0 no se usa.

const ECC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

export const ECC_CODEWORDS_PER_BLOCK = [
  // 0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

export const NUM_ECC_BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

/** Módulos disponibles para datos + ECC en una versión, antes de reservar patrones. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version, ecc) {
  const level = ECC_LEVELS[ecc];
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[level][version] * NUM_ECC_BLOCKS[level][version]
  );
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  // Separación uniforme y siempre par. La versión 32 es la única excepción de
  // la norma, donde la fórmula general daría 28 y el valor correcto es 26.
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = version * 4 + 10; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

// ─── Codificación de datos ───────────────────────────────────────────────────

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

/** Segmento en modo byte: 4 bits de modo + contador + los bytes UTF-8. */
function encodeSegment(bytes, version) {
  const buf = new BitBuffer();
  buf.push(0b0100, 4); // modo byte
  buf.push(bytes.length, version <= 9 ? 8 : 16); // longitud del contador según versión
  for (const b of bytes) buf.push(b, 8);
  return buf;
}

function pickVersion(byteLength, ecc, min, max) {
  for (let v = min; v <= max; v++) {
    const capacity = dataCodewords(v, ecc) * 8;
    const needed = 4 + (v <= 9 ? 8 : 16) + byteLength * 8;
    if (needed <= capacity) return v;
  }
  throw new Error('El texto no entra en un código QR con ese nivel de corrección');
}

function toCodewords(buf, version, ecc) {
  const capacity = dataCodewords(version, ecc) * 8;
  const bits = buf.bits.slice();

  // Terminador (hasta 4 ceros) y relleno hasta completar el último byte.
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    bytes.push(byte);
  }
  // Bytes de relleno alternados, como manda la norma.
  for (let pad = 0xec; bytes.length < capacity / 8; pad ^= 0xec ^ 0x11) bytes.push(pad);
  return Uint8Array.from(bytes);
}

/** Divide en bloques, calcula el ECC de cada uno e intercala todo. */
function interleave(data, version, ecc) {
  const level = ECC_LEVELS[ecc];
  const numBlocks = NUM_ECC_BLOCKS[level][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[level][version];
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlockLen = Math.floor(totalCodewords / numBlocks) - eccLen;
  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);

  const blocks = [];
  for (let i = 0, offset = 0; i < numBlocks; i++) {
    const len = shortBlockLen + (i < numShortBlocks ? 0 : 1);
    const chunk = data.slice(offset, offset + len);
    offset += len;
    blocks.push({ data: chunk, ecc: rsRemainder(chunk, eccLen) });
  }

  const out = [];
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (const block of blocks) {
      if (i < block.data.length) out.push(block.data[i]);
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (const block of blocks) out.push(block.ecc[i]);
  }
  return Uint8Array.from(out);
}

// ─── Dibujo de la matriz ─────────────────────────────────────────────────────

class Matrix {
  constructor(size) {
    this.size = size;
    this.modules = new Uint8Array(size * size);   // 1 = oscuro
    this.reserved = new Uint8Array(size * size);  // patrones fijos: no llevan datos
  }
  get(x, y) {
    return this.modules[y * this.size + x];
  }
  set(x, y, dark, reserve = false) {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    if (reserve) this.reserved[y * this.size + x] = 1;
  }
  isReserved(x, y) {
    return this.reserved[y * this.size + x] === 1;
  }
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      m.set(x, y, d !== 2 && d <= 3, true);
    }
  }
}

function drawFunctionPatterns(m, version) {
  const size = m.size;

  // Patrones de sincronismo (fila y columna 6).
  for (let i = 0; i < size; i++) {
    m.set(6, i, i % 2 === 0, true);
    m.set(i, 6, i % 2 === 0, true);
  }

  drawFinder(m, 3, 3);
  drawFinder(m, size - 4, 3);
  drawFinder(m, 3, size - 4);

  // Patrones de alineación.
  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const skipCorner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (skipCorner) continue;
      const cx = positions[i];
      const cy = positions[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          m.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
        }
      }
    }
  }

  // Espacio reservado para la información de formato. Ojo: (8,6) y (6,8) NO
  // son formato sino módulos del patrón de sincronismo, y quedan como están.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      m.set(i, 8, false, true);
      m.set(8, i, false, true);
    }
  }
  for (let i = 0; i < 8; i++) {
    m.set(size - 1 - i, 8, false, true);
    m.set(8, size - 1 - i, false, true);
  }
  m.set(8, size - 8, true, true); // módulo oscuro, siempre encendido

  // Información de versión (a partir de la versión 7).
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = ((version << 12) | rem) >>> 0;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.set(a, b, bit, true);
      m.set(b, a, bit, true);
    }
  }
}

function drawFormatBits(m, ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((data << 10) | rem) ^ 0x5412) >>> 0;
  const size = m.size;

  for (let i = 0; i <= 5; i++) m.set(8, i, ((bits >>> i) & 1) === 1, true);
  m.set(8, 7, ((bits >>> 6) & 1) === 1, true);
  m.set(8, 8, ((bits >>> 7) & 1) === 1, true);
  m.set(7, 8, ((bits >>> 8) & 1) === 1, true);
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, ((bits >>> i) & 1) === 1, true);

  for (let i = 0; i < 8; i++) m.set(size - 1 - i, 8, ((bits >>> i) & 1) === 1, true);
  for (let i = 8; i < 15; i++) m.set(8, size - 15 + i, ((bits >>> i) & 1) === 1, true);
  m.set(8, size - 8, true, true);
}

/** Recorrido en zigzag de abajo a arriba, dos columnas por vez. */
function drawCodewords(m, codewords) {
  const size = m.size;
  let bitIndex = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // la columna 6 es de sincronismo
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (m.isReserved(x, y)) continue;
        let dark = false;
        if (bitIndex < codewords.length * 8) {
          dark = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        m.set(x, y, dark);
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.isReserved(x, y)) continue;
      if (MASKS[mask](x, y)) m.modules[y * m.size + x] ^= 1;
    }
  }
}

/** Puntaje de penalización: se elige la máscara con el número más bajo. */
function penalty(m) {
  const size = m.size;
  let score = 0;

  // Reglas 1 y 3: corridas del mismo color y patrones tipo 1:1:3:1:1.
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      let runColor = -1;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const color = axis === 0 ? m.get(b, a) : m.get(a, b);
        if (color === runColor) {
          runLength++;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          history.pop();
          history.unshift(runLength);
          if (
            runColor === 0 &&
            history[0] >= 1 &&
            history[1] === history[0] &&
            history[2] === history[0] * 3 &&
            history[3] === history[0] &&
            history[4] === history[0]
          ) {
            score += 40;
          }
          runColor = color;
          runLength = 1;
        }
      }
    }
  }

  // Regla 2: bloques de 2x2 del mismo color.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.get(x, y);
      if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) score += 3;
    }
  }

  // Regla 4: desbalance entre módulos oscuros y claros.
  let dark = 0;
  for (const v of m.modules) dark += v;
  const total = size * size;
  const k = Math.floor((Math.abs(dark * 20 - total * 10) * 10) / total);
  score += k * 10;

  return score;
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Devuelve { version, size, modules } donde `modules` es un Uint8Array de
 * size×size con 1 = módulo oscuro.
 */
export function encodeQr(text, { ecc = 'M', minVersion = 1, maxVersion = 40 } = {}) {
  if (ECC_LEVELS[ecc] === undefined) throw new Error(`Nivel de corrección desconocido: ${ecc}`);
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length, ecc, minVersion, maxVersion);

  const codewords = interleave(toCodewords(encodeSegment(bytes, version), version, ecc), version, ecc);

  const size = version * 4 + 17;
  const matrix = new Matrix(size);
  drawFunctionPatterns(matrix, version);
  drawCodewords(matrix, codewords);

  // Probamos las ocho máscaras y nos quedamos con la de menor penalización:
  // es lo que hace que el código se lea bien con cualquier cámara.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(matrix, mask);
    drawFormatBits(matrix, ecc, mask);
    const score = penalty(matrix);
    if (!best || score < best.score) best = { mask, score, modules: matrix.modules.slice() };
    applyMask(matrix, mask); // XOR de nuevo: deshace la máscara
  }

  matrix.modules = best.modules;
  return { version, size, modules: matrix.modules, mask: best.mask };
}

/** El QR como cadena SVG, listo para inyectar en el DOM. */
export function qrSvg(text, { ecc = 'M', margin = 2, dark = '#111318', light = '#ffffff' } = {}) {
  const { size, modules } = encodeQr(text, { ecc });
  const dim = size + margin * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y * size + x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Código QR de la entrada">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}
