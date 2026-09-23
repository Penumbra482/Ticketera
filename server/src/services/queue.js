import { db, tx } from '../db.js';
import { token as newToken, nowIso, inSeconds, notFound, conflict } from '../lib/util.js';

/**
 * Cola virtual justa.
 *
 * Reglas de diseño, pensadas contra lo que rompe en las ticketeras clásicas:
 *
 *  1. FIFO estricto por `position`. Nadie se adelanta, y la posición nunca
 *     empeora: es un entero asignado al entrar y no se recalcula.
 *  2. El token vive en el navegador (localStorage). Refrescar, cerrar la
 *     pestaña o cambiar de red NO hace perder el lugar.
 *  3. Admisión por capacidad: como máximo `queue_capacity` compradores
 *     trabajando en simultáneo. Cuando uno termina o se le vence el tiempo,
 *     entra el siguiente automáticamente.
 *  4. Reloj visible: el admitido tiene `admit_ttl_secs` para comprar, y el que
 *     espera ve cuántos tiene adelante y un ETA calculado con el ritmo real de
 *     admisiones (no un número inventado).
 */

const RATE_WINDOW_MS = 5 * 60 * 1000; // ventana para medir el ritmo de admisión

export function joinQueue(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) throw notFound('Evento no encontrado');

  return tx(() => {
    const last = db
      .prepare('SELECT MAX(position) AS m FROM queue_tokens WHERE event_id = ?')
      .get(eventId);
    const position = (last?.m ?? 0) + 1;
    const t = newToken();
    db.prepare(
      `INSERT INTO queue_tokens (token, event_id, position, status, joined_at)
       VALUES (?, ?, ?, 'waiting', ?)`
    ).run(t, eventId, position, nowIso());
    admitNext(eventId);
    return { token: t, position };
  });
}

/** Admite tantos tokens en espera como slots libres haya. Idempotente. */
export function admitNext(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return 0;

  expireStale(eventId);

  const active = db
    .prepare(`SELECT COUNT(*) AS c FROM queue_tokens WHERE event_id = ? AND status = 'admitted'`)
    .get(eventId).c;

  let slots = Math.max(0, event.queue_capacity - active);
  if (slots === 0) return 0;

  const waiting = db
    .prepare(
      `SELECT token FROM queue_tokens
       WHERE event_id = ? AND status = 'waiting'
       ORDER BY position ASC LIMIT ?`
    )
    .all(eventId, slots);

  const stmt = db.prepare(
    `UPDATE queue_tokens SET status = 'admitted', admitted_at = ?, expires_at = ?
     WHERE token = ? AND status = 'waiting'`
  );
  let admitted = 0;
  for (const row of waiting) {
    stmt.run(nowIso(), inSeconds(event.admit_ttl_secs), row.token);
    admitted++;
  }
  return admitted;
}

/** Marca como vencidos los admitidos que no compraron a tiempo. */
export function expireStale(eventId = null) {
  if (eventId) {
    return db
      .prepare(
        `UPDATE queue_tokens SET status = 'expired'
         WHERE status = 'admitted' AND expires_at IS NOT NULL AND expires_at < ?
           AND event_id = ?`
      )
      .run(nowIso(), eventId).changes;
  }
  return db
    .prepare(
      `UPDATE queue_tokens SET status = 'expired'
       WHERE status = 'admitted' AND expires_at IS NOT NULL AND expires_at < ?`
    )
    .run(nowIso()).changes;
}

export function queueStatus(t) {
  const row = db.prepare('SELECT * FROM queue_tokens WHERE token = ?').get(t);
  if (!row) throw notFound('Token de cola inválido');

  expireStale(row.event_id);
  admitNext(row.event_id);

  const fresh = db.prepare('SELECT * FROM queue_tokens WHERE token = ?').get(t);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(fresh.event_id);

  const ahead = db
    .prepare(
      `SELECT COUNT(*) AS c FROM queue_tokens
       WHERE event_id = ? AND status = 'waiting' AND position < ?`
    )
    .get(fresh.event_id, fresh.position).c;

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM queue_tokens WHERE event_id = ? AND status = 'waiting'`)
    .get(fresh.event_id).c;

  return {
    token: fresh.token,
    event_id: fresh.event_id,
    status: fresh.status,
    position: fresh.position,
    ahead,
    total_waiting: total,
    eta_seconds: fresh.status === 'admitted' ? 0 : estimateEta(fresh.event_id, ahead, event),
    expires_at: fresh.expires_at,
    seconds_left: fresh.expires_at
      ? Math.max(0, Math.round((new Date(fresh.expires_at) - Date.now()) / 1000))
      : null,
  };
}

/**
 * ETA con el ritmo real de admisiones de los últimos minutos. Si todavía no
 * hay historia (evento recién abierto), cae a una estimación conservadora
 * basada en capacidad y TTL. Siempre devolvemos un número honesto: preferimos
 * decir "unos 6 minutos" y que salga antes, a mostrar un contador que se
 * congela.
 */
function estimateEta(eventId, ahead, event) {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS c FROM queue_tokens
       WHERE event_id = ? AND admitted_at IS NOT NULL AND admitted_at > ?`
    )
    .get(eventId, since).c;

  const perSecond = recent > 0 ? recent / (RATE_WINDOW_MS / 1000) : null;
  if (perSecond && perSecond > 0) return Math.round((ahead + 1) / perSecond);

  // Sin historia: cada slot se libera, como mucho, cada admit_ttl_secs.
  const rounds = Math.ceil((ahead + 1) / Math.max(1, event.queue_capacity));
  return rounds * Math.round(event.admit_ttl_secs * 0.6);
}

/** El token se consume al confirmar la compra: libera el slot al instante. */
export function consumeToken(t) {
  if (!t) return;
  const row = db.prepare('SELECT * FROM queue_tokens WHERE token = ?').get(t);
  if (!row) return;
  db.prepare(`UPDATE queue_tokens SET status = 'used' WHERE token = ?`).run(t);
  admitNext(row.event_id);
}

/** Valida que el token pueda operar sobre el evento (o que no haga falta cola). */
export function assertAdmitted(event, t) {
  if (!event.queue_enabled) return null;
  if (!t) throw conflict('Este evento tiene cola de espera. Sumate a la cola primero.', 'queue_required');
  const row = db.prepare('SELECT * FROM queue_tokens WHERE token = ?').get(t);
  if (!row || row.event_id !== event.id) throw conflict('Token de cola inválido', 'queue_invalid');
  if (row.status === 'expired') throw conflict('Se venció tu turno. Volvé a la cola.', 'queue_expired');
  if (row.status !== 'admitted') throw conflict('Todavía estás en la cola', 'queue_waiting');
  return row;
}
