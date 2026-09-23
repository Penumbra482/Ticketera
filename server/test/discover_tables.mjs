/**
 * Herramienta de desarrollo (no forma parte de la app).
 *
 * Deriva las tablas de bloques de corrección de error del QR probando
 * candidatos contra un decodificador independiente (OpenCV): solo la
 * combinación correcta de (codewords de ECC por bloque, cantidad de bloques)
 * produce un código que un lector real entiende.
 *
 * Va versión por versión y usa que la cantidad de bloques nunca baja al subir
 * de versión, así el espacio de búsqueda queda chico.
 *
 *   node test/discover_tables.mjs 1 40 [ruta/al/oracle.py]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { encodeQr, ECC_CODEWORDS_PER_BLOCK, NUM_ECC_BLOCKS } from '../../web/app/lib/qr.js';

const from = Number(process.argv[2] || 1);
const to = Number(process.argv[3] || 40);
const ORACLE = process.argv[4] || '/tmp/oracle.py';

const LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_CANDIDATES = [7, 10, 13, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30];
const RATIO = { L: [0.18, 0.29], M: [0.33, 0.42], Q: [0.45, 0.58], H: [0.58, 0.69] };

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function ask(cases) {
  const res = spawnSync('python3', [ORACLE], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    maxBuffer: 1e9,
  });
  if (res.status !== 0) throw new Error(res.stderr.slice(0, 800));
  return JSON.parse(res.stdout);
}

const minBlocks = { L: 1, M: 1, Q: 1, H: 1 };
const result = { L: {}, M: {}, Q: {}, H: {} };

for (let version = from; version <= to; version++) {
  const total = Math.floor(rawDataModules(version) / 8);
  const cases = [];

  for (const level of Object.keys(LEVELS)) {
    const [lo, hi] = RATIO[level];
    const lv = LEVELS[level];
    const keep = [ECC_CODEWORDS_PER_BLOCK[lv][version], NUM_ECC_BLOCKS[lv][version]];

    for (const e of ECC_CANDIDATES) {
      const centre = NUM_ECC_BLOCKS[lv][version];
      for (let b = Math.max(1, centre - 8); b <= centre + 8; b++) {
        const ratio = (e * b) / total;
        if (ratio < lo || ratio > hi) continue;
        const data = total - e * b;
        if (data <= 0 || Math.floor(total / b) - e < 1) continue;

        ECC_CODEWORDS_PER_BLOCK[lv][version] = e;
        NUM_ECC_BLOCKS[lv][version] = b;
        const headerBytes = version <= 9 ? 2 : 3;
        const text = 'Zx7q'.repeat(900).slice(0, Math.max(1, data - headerBytes));
        try {
          const m = encodeQr(text, { ecc: level, minVersion: version, maxVersion: version });
          cases.push({ level, e, b, text, size: m.size, modules: Array.from(m.modules).join('') });
        } catch {
          /* candidato imposible */
        }
      }
    }
    ECC_CODEWORDS_PER_BLOCK[lv][version] = keep[0];
    NUM_ECC_BLOCKS[lv][version] = keep[1];
  }

  const ok = ask(cases);
  const hits = { L: [], M: [], Q: [], H: [] };
  cases.forEach((c, i) => {
    if (ok[i]) hits[c.level].push(c);
  });

  const parts = [];
  for (const level of Object.keys(LEVELS)) {
    const lv = LEVELS[level];
    const current = `${ECC_CODEWORDS_PER_BLOCK[lv][version]}x${NUM_ECC_BLOCKS[lv][version]}`;
    const found = hits[level].map((h) => `${h.e}x${h.b}`);
    if (hits[level].length === 1) {
      const h = hits[level][0];
      result[level][version] = [h.e, h.b];
      minBlocks[level] = h.b;
    }
    const mark = found.length === 0 ? '?' : found.includes(current) ? ' ' : '!';
    parts.push(`${level}:${(found.join('/') || '—').padEnd(8)}${mark}`);
  }
  console.log(`v${String(version).padStart(2)}  ${parts.join('  ')}`);
}

fs.writeFileSync('/tmp/qr-tables.json', JSON.stringify(result));
console.error('escrito /tmp/qr-tables.json');
