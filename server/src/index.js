import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db, DB_FILE } from './db.js';
import { createApp } from './lib/http.js';
import { attachUser, findOrCreateUser, createSession } from './lib/auth.js';
import { wrap, bad, HttpError } from './lib/util.js';
import { events } from './routes/events.js';
import { checkoutRoutes } from './routes/checkout.js';
import { tickets } from './routes/tickets.js';
import { organizer } from './routes/organizer.js';
import { releaseExpired } from './services/inventory.js';
import { expireStale, admitNext } from './services/queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, '..', '..', 'web');

const app = createApp({
  staticDir: fs.existsSync(webDir) ? webDir : null,
  spaFallback: true,
});

app.use(attachUser);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── Auth de desarrollo ──────────────────────────────────────────────────────
// Email sin contraseña. En producción se cambia por magic link u OTP; el
// contrato con el cliente no cambia (devuelve { token, user } y se manda como
// Bearer). Ver README → "Qué falta para producción".
app.post(
  '/api/auth/login',
  wrap((req, res) => {
    const { email, name } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Email inválido');
    const user = findOrCreateUser({ email, name });
    const token = createSession(user.id);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  })
);

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'no_session' });
  const { id, email, name, role } = req.user;
  res.json({ user: { id, email, name, role } });
});

app.use('/api/events', events);
app.use('/api', checkoutRoutes);
app.use('/api', tickets);
app.use('/api', organizer);

// ─── Errores ─────────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal', message: 'Algo salió mal de nuestro lado' });
});

// ─── Tareas periódicas ───────────────────────────────────────────────────────
// Soltar reservas vencidas y hacer avanzar la cola. Con varias instancias esto
// se mueve a un worker aparte; con una sola, un intervalo alcanza.
const sweep = setInterval(() => {
  try {
    releaseExpired();
    expireStale();
    for (const e of db.prepare(`SELECT id FROM events WHERE queue_enabled = 1`).all()) {
      admitNext(e.id);
    }
  } catch (e) {
    console.error('sweep', e);
  }
}, 15_000);
sweep.unref?.();

// ─── Red de seguridad ────────────────────────────────────────────────────────
/**
 * Que el servidor no se muera nunca en silencio.
 *
 * Node, ante una excepción que nadie atrapó, termina el proceso. En un servidor
 * de producción eso está bien (que un supervisor lo reinicie limpio), pero acá
 * el efecto es que la persona ve "no se puede acceder a este sitio" sin ninguna
 * pista de qué pasó ni cuándo.
 *
 * Así que lo registramos —en pantalla y en un archivo— y seguimos sirviendo.
 * Se pierde esa petición, no la tarde entera.
 */
const LOG_FILE = path.join(path.dirname(DB_FILE), 'errores.log');

function logCrash(kind, error) {
  const detail = error?.stack || String(error);
  const entry = `\n[${new Date().toISOString()}] ${kind}\n${detail}\n`;
  console.error(`\n  ⚠ ${kind}: ${error?.message || error}`);
  console.error(`  El servidor sigue andando. El detalle quedó en:\n  ${LOG_FILE}\n`);
  try {
    fs.appendFileSync(LOG_FILE, entry);
  } catch {
    /* si no se puede escribir el log, con la consola alcanza */
  }
}

process.on('uncaughtException', (err) => logCrash('Excepción no atrapada', err));
process.on('unhandledRejection', (err) => logCrash('Promesa rechazada sin atrapar', err));

// ─── Primera vez ─────────────────────────────────────────────────────────────
// Si la base está vacía, cargamos los datos de ejemplo solos. `npm start` tiene
// que alcanzar: obligar a acordarse de un `npm run seed` previo es una forma
// segura de que alguien vea una pantalla sin eventos y piense que está roto.
const eventCount = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
if (eventCount === 0) {
  console.log('  Base vacía: cargando los eventos de ejemplo…');
  const { runSeed } = await import('./seed.js');
  const { counts } = runSeed({ quiet: true });
  console.log(`  Listo: ${counts.eventos} eventos, ${counts.entradas_emitidas} entradas emitidas.`);
}

/**
 * Abre el navegador en la página, si quien arrancó el servidor lo pidió
 * (`TT_OPEN=1`, que es lo que hacen iniciar.cmd e iniciar.sh).
 *
 * Va acá y no en los scripts de arranque por dos razones: el navegador se abre
 * cuando el servidor ya está escuchando —y no después de esperar unos segundos
 * y cruzar los dedos—, y la parte complicada queda en JavaScript en vez de en
 * comillas anidadas de un archivo .cmd, que es donde se rompe.
 */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // Si el comando no existe, el error llega como evento, no como excepción:
    // sin este manejador, Node termina el proceso y el servidor no arranca.
    child.on('error', () => {});
    child.unref();
  } catch {
    /* si no hay navegador o el comando no existe, el enlace de arriba alcanza */
  }
}

const PORT = Number(process.env.PORT || 4000);
if (process.env.TT_NO_LISTEN !== '1') {
  const server = app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Tres Tickets está andando.`);
    console.log(`\n     Abrí  →  ${url}`);
    console.log(`     API   →  ${url}/api`);
    console.log(`\n  Para entrar como organizador: productora@trestickets.test`);
    console.log(`  (se entra solo con el email, sin contraseña)\n`);
    if (process.env.TT_OPEN === '1') openBrowser(url);
  });

  // El error más común después de "no lo levanté": levantarlo dos veces.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  El puerto ${PORT} ya está ocupado.\n` +
          '  Puede que Tres Tickets ya esté corriendo en otra terminal: probá\n' +
          `  abrir http://localhost:${PORT} antes de levantarlo de nuevo.\n\n` +
          `  Si querés otro puerto:  PORT=4001 npm start\n`
      );
      process.exit(1);
    }
    throw err;
  });
}

export { app };
