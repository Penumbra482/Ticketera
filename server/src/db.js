import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SQLite a través del módulo nativo de Node (`node:sqlite`, Node 22+).
 *
 * Elegimos esto sobre better-sqlite3 para que el proyecto arranque sin
 * compilar módulos nativos: `npm install && npm start` y listo. La API es
 * síncrona, así que el flujo crítico (reservar butaca / vender) corre dentro
 * de una transacción real sin condiciones de carrera.
 *
 * Para escalar a varios procesos hay que migrar a Postgres: la capa de acceso
 * está toda acá y en /services, no hay SQL suelto por el resto del código.
 */

/**
 * `node:sqlite` existe desde Node 22.5. Si la versión es más vieja, el error
 * que tira Node ("Cannot find module node:sqlite") no le dice nada a nadie, así
 * que lo cambiamos por uno que sí explica qué hacer.
 */
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    `\n  Tres Tickets necesita Node 22.5 o más nuevo, y esta es la ${process.version}.\n` +
      '  La base de datos usa el SQLite que viene adentro de Node (node:sqlite),\n' +
      '  que no existe en versiones anteriores.\n\n' +
      '  Actualizá Node y volvé a intentar: https://nodejs.org\n'
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TT_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.TT_DB || path.join(DATA_DIR, 'tres-tickets.db');

if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 4000');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

/**
 * Migraciones mínimas: `CREATE TABLE IF NOT EXISTS` no agrega columnas nuevas a
 * una base que ya existe, así que las sumamos a mano. Es idempotente y corre en
 * cada arranque; alcanza mientras las migraciones sean solo columnas nuevas con
 * valor por defecto. Cuando dejen de serlo, hay que pasar a archivos numerados.
 */
const ADDED_COLUMNS = [
  ['price_tiers', 'kind', "TEXT NOT NULL DEFAULT 'general'"],
  ['orders', 'channel', "TEXT NOT NULL DEFAULT 'web'"],
  ['orders', 'operator_id', 'TEXT'],
  ['orders', 'note', 'TEXT'],
  ['tickets', 'channel', "TEXT NOT NULL DEFAULT 'web'"],
];

for (const [table, column, definition] of ADDED_COLUMNS) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Limpieza de la reventa entre usuarios, que se dio de baja del producto.
 * Una base creada con la versión anterior se queda con la tabla `listings`, las
 * dos columnas de tope de reventa y entradas en estado 'listed' o 'resold'. Las
 * publicaciones abiertas se cancelan devolviendo la entrada a su dueño, que es
 * lo que corresponde: nadie pierde nada, simplemente deja de estar publicada.
 */
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
  .all()
  .map((r) => r.name);

if (tables.includes('listings')) {
  db.exec(`UPDATE tickets SET status = 'valid' WHERE status = 'listed'`);
  db.exec('DROP TABLE listings');
}

for (const column of ['resale_enabled', 'resale_cap_pct']) {
  const existing = db.prepare('PRAGMA table_info(events)').all();
  if (existing.some((c) => c.name === column)) db.exec(`ALTER TABLE events DROP COLUMN ${column}`);
}

let depth = 0;

/**
 * Ejecuta fn dentro de una transacción; soporta anidamiento con SAVEPOINT
 * para que un servicio pueda llamar a otro sin romper la atomicidad.
 */
export function tx(fn) {
  const name = `sp_${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${name}`);
  depth++;
  try {
    const out = fn();
    depth--;
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    depth--;
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${name}`);
    } catch {
      /* la transacción ya se había cerrado */
    }
    throw err;
  }
}

export { DB_FILE };
