import { db, tx } from '../db.js';
import { id, qrSecret, orderCode, nowIso, bad, conflict, notFound } from '../lib/util.js';
import { holdDetail, releaseExpired } from './inventory.js';
import { consumeToken } from './queue.js';

/**
 * Checkout de un solo paso.
 *
 * Todo lo que el usuario necesita decidir ya está decidido antes de llegar acá:
 * el precio final se mostró desde la grilla, las butacas están reservadas y el
 * reloj es visible. Este endpoint solo confirma. Es una transacción única:
 * o se emiten todas las entradas o no se emite ninguna.
 */

export function checkout({ holdId, user, payment = {} }) {
  releaseExpired();

  return tx(() => {
    const hold = db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId);
    if (!hold) throw notFound('Reserva no encontrada');
    if (hold.status === 'converted') throw conflict('Esta reserva ya se pagó', 'already_paid');
    if (hold.status !== 'active')
      throw conflict('Se venció la reserva. Volvé a elegir tus lugares.', 'hold_expired');
    if (new Date(hold.expires_at) <= new Date())
      throw conflict('Se venció la reserva. Volvé a elegir tus lugares.', 'hold_expired');

    const detail = holdDetail(holdId);
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(hold.event_id);

    const order = {
      id: id('ord'),
      code: orderCode(),
      event_id: event.id,
      user_id: user.id,
      kind: 'primary',
      channel: 'web',
      subtotal_cents: detail.subtotal_cents,
      fees_cents: detail.fees_cents,
      total_cents: detail.total_cents,
      status: 'paid',
      payment_brand: payment.brand || 'visa',
      payment_last4: String(payment.last4 || '4242').slice(-4),
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO orders (id, code, event_id, user_id, kind, channel, subtotal_cents, fees_cents,
                           total_cents, status, payment_brand, payment_last4, created_at)
       VALUES (@id, @code, @event_id, @user_id, @kind, @channel, @subtotal_cents, @fees_cents,
               @total_cents, @status, @payment_brand, @payment_last4, @created_at)`
    ).run(order);

    const insertTicket = db.prepare(
      `INSERT INTO tickets (id, order_id, event_id, owner_id, seat_id, tier_id, face_cents,
                            fee_cents, holder_name, channel, qr_secret, status, created_at)
       VALUES (@id, @order_id, @event_id, @owner_id, @seat_id, @tier_id, @face_cents,
               @fee_cents, @holder_name, 'web', @qr_secret, 'valid', @created_at)`
    );

    const tickets = [];
    for (const item of detail.items) {
      for (let i = 0; i < item.quantity; i++) {
        const ticket = {
          id: id('tkt'),
          order_id: order.id,
          event_id: event.id,
          owner_id: user.id,
          seat_id: item.seat?.id || null,
          tier_id: item.tier_id,
          face_cents: item.face_cents,
          fee_cents: item.fee_cents,
          holder_name: user.name,
          qr_secret: qrSecret(),
          created_at: nowIso(),
        };
        insertTicket.run(ticket);
        tickets.push(ticket.id);
      }
    }

    // Convertir el inventario: los holds pasan a venta definitiva.
    const items = db.prepare('SELECT * FROM hold_items WHERE hold_id = ?').all(holdId);
    for (const it of items) {
      if (it.seat_id) {
        const res = db
          .prepare(`UPDATE seats SET status = 'sold' WHERE id = ? AND hold_id = ?`)
          .run(it.seat_id, holdId);
        if (res.changes !== 1) throw conflict('La butaca ya no está disponible', 'seats_taken');
      } else {
        db.prepare(
          `UPDATE ga_inventory SET held = MAX(0, held - ?), sold = sold + ?
           WHERE event_id = ? AND tier_id = ?`
        ).run(it.quantity, it.quantity, event.id, it.tier_id);
      }
    }

    db.prepare(`UPDATE holds SET status = 'converted' WHERE id = ?`).run(holdId);
    consumeToken(hold.queue_token);

    return { order_id: order.id, code: order.code, ticket_ids: tickets };
  });
}

export function orderView(codeOrId) {
  const order = db
    .prepare('SELECT * FROM orders WHERE code = ? OR id = ?')
    .get(codeOrId, codeOrId);
  if (!order) throw notFound('Orden no encontrada');
  const event = db
    .prepare(
      `SELECT e.*, v.name AS venue_name, v.city FROM events e
       JOIN venues v ON v.id = e.venue_id WHERE e.id = ?`
    )
    .get(order.event_id);
  const tickets = db
    .prepare(
      `SELECT t.*, s.section, s.row_label, s.seat_number, pt.name AS tier_name, pt.color
       FROM tickets t
       LEFT JOIN seats s ON s.id = t.seat_id
       JOIN price_tiers pt ON pt.id = t.tier_id
       WHERE t.order_id = ?`
    )
    .all(order.id);
  return { order, event, tickets: tickets.map(ticketView) };
}

export function ticketView(t) {
  return {
    id: t.id,
    event_id: t.event_id,
    status: t.status,
    holder_name: t.holder_name,
    tier_name: t.tier_name,
    color: t.color,
    face_cents: t.face_cents,
    fee_cents: t.fee_cents,
    paid_cents: t.face_cents + t.fee_cents,
    seat: t.seat_id
      ? { id: t.seat_id, section: t.section, row: t.row_label, number: t.seat_number }
      : null,
    created_at: t.created_at,
  };
}

/** Devolución completa antes del evento: suelta el lugar para que otro lo compre. */
export function refundOrder({ orderId, user }) {
  return tx(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? OR code = ?').get(orderId, orderId);
    if (!order) throw notFound('Orden no encontrada');
    if (order.user_id !== user.id) throw conflict('Esta orden no es tuya', 'not_owner');
    if (order.status === 'refunded') throw conflict('Ya fue devuelta', 'already_refunded');

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(order.event_id);
    if (new Date(event.starts_at) <= new Date())
      throw bad('El evento ya empezó: no se puede devolver');

    const tickets = db.prepare('SELECT * FROM tickets WHERE order_id = ?').all(order.id);
    for (const t of tickets) {
      db.prepare(`UPDATE tickets SET status = 'refunded' WHERE id = ?`).run(t.id);
      if (t.seat_id) {
        db.prepare(`UPDATE seats SET status = 'available', hold_id = NULL WHERE id = ?`).run(t.seat_id);
      } else {
        db.prepare(`UPDATE ga_inventory SET sold = MAX(0, sold - 1) WHERE event_id = ? AND tier_id = ?`)
          .run(t.event_id, t.tier_id);
      }
    }
    db.prepare(`UPDATE orders SET status = 'refunded' WHERE id = ?`).run(order.id);
    return { refunded_cents: order.total_cents, code: order.code };
  });
}
