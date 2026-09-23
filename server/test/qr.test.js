import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeQr, qrSvg } from '../../web/app/lib/qr.js';

/**
 * El generador de QR está escrito a mano, así que hace falta una contraprueba
 * que no comparta su código: le pasamos las matrices a OpenCV (Python) y
 * exigimos que las decodifique de vuelta al texto exacto.
 *
 * Si en la máquina no hay OpenCV, las pruebas estructurales igual corren y las
 * de decodificación se saltean con un aviso.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DECODER = path.join(__dirname, 'decode_qr.py');

const hasOpenCv = (() => {
  const probe = spawnSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' });
  return probe.status === 0;
})();

function decodeAll(cases) {
  const payload = cases.map((c) => {
    const { size, modules } = encodeQr(c.text, { ecc: c.ecc || 'M' });
    return { label: c.label, text: c.text, size, modules: Array.from(modules).join('') };
  });
  const res = spawnSync('python3', [DECODER], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`el decodificador falló: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('la matriz tiene el tamaño y los patrones de posición que manda la norma', () => {
  const { size, version, modules } = encodeQr('tres-tickets', { ecc: 'M' });
  assert.equal(size, version * 4 + 17);

  // Los tres ojos: anillo oscuro de 7x7 con centro macizo de 3x3.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    assert.equal(modules[cy * size + cx], 1, 'centro del patrón de posición');
    assert.equal(modules[(cy - 2) * size + cx], 0, 'anillo blanco del patrón');
    assert.equal(modules[(cy - 3) * size + cx], 1, 'borde exterior del patrón');
  }

  // Patrón de sincronismo: alterna en la fila 6.
  for (let x = 8; x < size - 8; x++) {
    assert.equal(modules[6 * size + x], x % 2 === 0 ? 1 : 0);
  }
});

test('elige la versión más chica en la que entra el texto', () => {
  assert.equal(encodeQr('a'.repeat(10), { ecc: 'M' }).version, 1);
  assert.ok(encodeQr('a'.repeat(200), { ecc: 'M' }).version > 5);
  // Más corrección de error ⇒ menos datos por versión.
  assert.ok(encodeQr('a'.repeat(60), { ecc: 'H' }).version > encodeQr('a'.repeat(60), { ecc: 'L' }).version);
});

test('el SVG sale bien formado y con zona de silencio', () => {
  const svg = qrSvg('tres://t/tkt_demo.secreto.firma');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
});

test(
  'OpenCV decodifica de vuelta el texto exacto',
  { skip: hasOpenCv ? false : 'OpenCV (python3-opencv) no está instalado' },
  () => {
    const cases = [
      { label: 'entrada real', text: 'tres://t/tkt_9xKq2mF7bQwZ.aB3dEf6HjK9mNpQr.7fA2bC9dE1gH', ecc: 'M' },
      { label: 'corto', text: 'TT-7F3K2Q', ecc: 'M' },
      { label: 'acentos', text: 'Compañía Teatro Vivo — Fila C, butaca 12', ecc: 'M' },
      { label: 'nivel L', text: 'tres://t/tkt_abcdefghijkl.mnopqrstuvwx.yz0123456789', ecc: 'L' },
      { label: 'nivel Q', text: 'tres://t/tkt_abcdefghijkl.mnopqrstuvwx.yz0123456789', ecc: 'Q' },
      { label: 'nivel H', text: 'tres://t/tkt_abcdefghijkl.mnopqrstuvwx.yz0123456789', ecc: 'H' },
      { label: 'largo (varios bloques)', text: 'x'.repeat(300), ecc: 'M' },
      { label: 'muy largo', text: 'tres-tickets '.repeat(60), ecc: 'L' },
    ];

    for (const r of decodeAll(cases)) {
      assert.ok(r.ok, `"${r.label}" no se decodificó igual (leído: ${JSON.stringify(r.decoded)})`);
    }
  }
);

test(
  'barrido de versiones 1 a 18 en los cuatro niveles de corrección',
  { skip: hasOpenCv ? false : 'OpenCV (python3-opencv) no está instalado' },
  () => {
    const cases = [];
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      for (let len = 1; len <= 430; len += 11) {
        const text = 'A1b2C3d4-N '.repeat(60).slice(0, len);
        // Más allá de la versión 18 las tablas todavía no están verificadas
        // contra un lector real: ver README → "El generador de QR".
        if (encodeQr(text, { ecc }).version > 18) continue;
        cases.push({ label: `${ecc} · ${len} bytes`, text, ecc });
      }
    }
    assert.ok(cases.length > 100, 'el barrido tiene que cubrir bastante');
    for (const r of decodeAll(cases)) {
      assert.ok(r.ok, `"${r.label}" no se decodificó igual (leído: ${JSON.stringify(r.decoded)})`);
    }
  }
);
