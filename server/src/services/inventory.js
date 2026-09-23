import { db, tx } from '../db.js';
import { id, nowIso, inSeconds, bad, conflict, notFound } from '../lib/util.js';

/**
 * Reserva temporal (hold) de butacas o de entradas generales.
 *
 * El hold es lo que hace que el mapa de asientos sea honesto: en el momento en
 * que tocás una butaca queda tuya por HOLD_SECONDS y desaparece del mapa de
 * los demás. Nada de "elegiste el asiento y al pagar te dice que ya no está".
 */

export const HOLD_SECONDS = Number(process.env.TT_HOLD_SECONDS || 600); // 10 minutos

export function createSeatHold({ event, seatIds, queueToken, userId }) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) throw bad('Elegí al menos una butaca');
  if (seatIds.length > event.max_per_order)
    throw bad(`Máximo ${event.max_per_order} entradas por compra`);

  return tx(() => {
    releaseExpired();

    const placeholders = seatIds.map(() => '?').join(',');
    const seats = db
      .prepare(`SELECT * FROM seats WHERE id IN (${placeholders}) AND event_id = ?`)
      .all(...seatIds, event.id);

    if (seats.length !== seatIds.length) throw notFound('Alguna butaca no existe en este evento');
    const taken = seats.filter((s) => s.status !== 'available');
    if (taken.length) {
      throw conflict(
        `Se acaban de tomar ${taken.length === 1 ? 'la butaca' : 'las butacas'} ` +
          taken.map((s) => `${s.row_label}${s.seat_number}`).join(', '),
        'seats_taken'
      );
    }

    const hold = {
      id: id('hld'),
      event_id: event.id,
      queue_token: queueToken || null,
      user_id: userId || null,
      status: 'active',
      created_at: nowIso(),
      expires_at: inSeconds(HOLD_SECONDS),
    };
    db.prepare(
      `INSERT INTO holds (id, event_id, queue_token, user_id, status, created_at, expires_at)
       VALUES (@id, @event_id, @queue_token, @user_id, @status, @created_at, @expires_at)`
    ).run(hold);

    const markSeat = db.prepare(
      `UPDATE seats SET status = 'held', hold_id = ? WHERE id = ? AND status = 'available'`
    );
    const addItem = db.prepare(
      `INSERT INTO hold_items (id, hold_id, seat_id, tier_id, quantity) VALUES (?, ?, ?, ?, 1)`
    );
    for (const seat of seats) {
      const res = markSeat.run(hold.id, seat.id);
      if (res.changes !== 1) throw conflict('Se acaba de tomar una de las butacas', 'seats_taken');
      addItem.run(id('hit'), hold.id, seat.id, seat.tier_id);
    }
    return hold;
  });
}

export function createGaHold({ event, lines, queueToken, userId }) {
  if (!Array.isArray(lines) || lines.length === 0) throw bad('Elegí al menos una entrada');
  const qty = lines.reduce((a, l) => a + Number(l.quantity || 0), 0);
  if (qty <= 0) throw bad('Elegí al menos una entrada');
  if (qty > event.max_per_order) throw bad(`Máximo ${event.max_per_order} entradas por compra`);

  return tx(() => {
    releaseExpired();

    const hold = {
      id: id('hld'),
      event_id: event.id,
      queue_token: queueToken || null,
      user_id: userId || null,
      status: 'active',
      created_at: nowIso(),
      expires_at: inSeconds(HOLD_SECONDS),
    };
    db.prepare(
      `INSERT INTO holds (id, event_id, queue_token, user_id, status, created_at, expires_at)
       VALUES (@id, @event_id, @queue_token, @user_id, @status, @created_at, @expires_at)`
    ).run(hold);

    const addItem = db.prepare(
      `INSERT INTO hold_items (id, hold_id, seat_id, tier_id, quantity) VALUES (?, ?, NULL, ?, ?)`
    );
    for (const line of lines) {
      const quantity = Number(line.quantity || 0);
      if (quantity <= 0) continue;
      const inv = db
        .prepare('SELECT * FROM ga_inventory WHERE event_id = ? AND tier_id = ?')
        .get(event.id, line.tier_id);
      if (!inv) throw notFound('Tipo de entrada no encontrado');
      const free = inv.quantity - inv.held - inv.sold;
      if (free < quantity)
        throw conflict(`Quedan ${free} entradas de ${line.tier_id}`, 'sold_out');
      db.prepare('UPDATE ga_inventory SET held = held + ? WHERE id = ?').run(quantity, inv.id);
      addItem.run(id('hit'), hold.id, line.tier_id, quantity);
    }
    return hold;
  });
}

/** Devuelve el hold con sus items resueltos y el detalle de precios. */
export function holdDetail(holdId) {
  const hold = db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId);
  if (!hold) throw notFound('Reserva no encontrada');
  const items = db
    .prepare(
      `SELECT hi.*, t.name AS tier_name, t.color, t.price_cents, t.fee_cents,
              s.section, s.row_label, s.seat_number
       FROM hold_items hi
       JOIN price_tiers t ON t.id = hi.tier_id
       LEFT JOIN seats s ON s.id = hi.seat_id
       WHERE hi.hold_id = ?`
    )
    .all(holdId);

  let subtotal = 0;
  let fees = 0;
  for (const it of items) {
    subtotal += it.price_cents * it.quantity;
    fees += it.fee_cents * it.quantity;
  }

  return {
    id: hold.id,
    event_id: hold.event_id,
    status: hold.status,
    expires_at: hold.expires_at,
    seconds_left: Math.max(0, Math.round((new Date(hold.expires_at) - Date.now()) / 1000)),
    items: items.map((it) => ({
      id: it.id,
      tier_id: it.tier_id,
      tier_name: it.tier_name,
      color: it.color,
      quantity: it.quantity,
      seat: it.seat_id
        ? { id: it.seat_id, section: it.section, row: it.row_label, number: it.seat_number }
        : null,
      face_cents: it.price_cents,
      fee_cents: it.fee_cents,
      total_cents: (it.price_cents + it.fee_cents) * it.quantity,
    })),
    subtotal_cents: subtotal,
    fees_cents: fees,
    total_cents: subtotal + fees,
  };
}

/** Suelta holds vencidos y devuelve el inventario. Corre en cada operación crítica
 *  y además cada 15s en un intervalo, así el mapa se refresca solo. */
export function releaseExpired() {
  const expired = db
    .prepare(`SELECT * FROM holds WHERE status = 'active' AND expires_at < ?`)
    .all(nowIso());
  for (const hold of expired) releaseHold(hold.id, 'expired');
  return expired.length;
}

export function releaseHold(holdId, status = 'released') {
  const hold = db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId);
  if (!hold || hold.status !== 'active') return false;
  const items = db.prepare('SELECT * FROM hold_items WHERE hold_id = ?').all(holdId);
  for (const it of items) {
    if (it.seat_id) {
      db.prepare(
        `UPDATE seats SET status = 'available', hold_id = NULL WHERE id = ? AND status = 'held'`
      ).run(it.seat_id);
    } else {
      db.prepare(
        'UPDATE ga_inventory SET held = MAX(0, held - ?) WHERE event_id = ? AND tier_id = ?'
      ).run(it.quantity, hold.event_id, it.tier_id);
    }
  }
  db.prepare('UPDATE holds SET status = ? WHERE id = ?').run(status, holdId);
  return true;
}

/** Resumen de disponibilidad para la ficha del evento. */
export function availability(event) {
  if (event.seating_type === 'ga') {
    const rows = db
      .prepare(
        `SELECT gi.*, t.name, t.color, t.price_cents, t.fee_cents, t.sort_order
         FROM ga_inventory gi JOIN price_tiers t ON t.id = gi.tier_id
         WHERE gi.event_id = ? ORDER BY t.sort_order`
      )
      .all(event.id);
    return rows.map((r) => ({
      tier_id: r.tier_id,
      name: r.name,
      color: r.color,
      face_cents: r.price_cents,
      fee_cents: r.fee_cents,
      total_cents: r.price_cents + r.fee_cents,
      available: r.quantity - r.held - r.sold,
      quantity: r.quantity,
    }));
  }
  return db
    .prepare(
      `SELECT t.id AS tier_id, t.name, t.color, t.price_cents, t.fee_cents,
              SUM(CASE WHEN s.status = 'available' THEN 1 ELSE 0 END) AS available,
              COUNT(s.id) AS quantity
       FROM price_tiers t LEFT JOIN seats s ON s.tier_id = t.id
       WHERE t.event_id = ? GROUP BY t.id ORDER BY t.sort_order`
    )
    .all(event.id)
    .map((r) => ({
      tier_id: r.tier_id,
      name: r.name,
      color: r.color,
      face_cents: r.price_cents,
      fee_cents: r.fee_cents,
      total_cents: r.price_cents + r.fee_cents,
      available: r.available || 0,
      quantity: r.quantity || 0,
    }));
}
