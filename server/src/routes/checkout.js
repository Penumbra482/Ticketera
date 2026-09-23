import { Router } from '../lib/http.js';
import { db } from '../db.js';
import { wrap, notFound, bad } from '../lib/util.js';
import { requireUser } from '../lib/auth.js';
import { createSeatHold, createGaHold, holdDetail, releaseHold, HOLD_SECONDS } from '../services/inventory.js';
import { joinQueue, queueStatus, assertAdmitted } from '../services/queue.js';
import { checkout, orderView, refundOrder } from '../services/orders.js';

export const checkoutRoutes = Router();

function eventBy(idOrSlug) {
  const row = db.prepare('SELECT * FROM events WHERE slug = ? OR id = ?').get(idOrSlug, idOrSlug);
  if (!row) throw notFound('Evento no encontrado');
  return row;
}

// ─── Cola virtual ────────────────────────────────────────────────────────────

checkoutRoutes.post(
  '/events/:slug/queue',
  wrap((req, res) => {
    const event = eventBy(req.params.slug);
    if (!event.queue_enabled)
      return res.json({ status: 'admitted', token: null, position: 0, ahead: 0, eta_seconds: 0 });
    const { token } = joinQueue(event.id);
    res.status(201).json(queueStatus(token));
  })
);

checkoutRoutes.get(
  '/queue/:token',
  wrap((req, res) => res.json(queueStatus(req.params.token)))
);

// ─── Reservas (holds) ────────────────────────────────────────────────────────

/**
 * POST /api/events/:slug/holds
 * body: { seat_ids?: string[], lines?: [{tier_id, quantity}], queue_token? }
 */
checkoutRoutes.post(
  '/events/:slug/holds',
  wrap((req, res) => {
    const event = eventBy(req.params.slug);
    const queueToken = req.body.queue_token || null;
    assertAdmitted(event, queueToken);

    const hold =
      event.seating_type === 'reserved'
        ? createSeatHold({
            event,
            seatIds: req.body.seat_ids,
            queueToken,
            userId: req.user?.id,
          })
        : createGaHold({ event, lines: req.body.lines, queueToken, userId: req.user?.id });

    res.status(201).json({ hold: holdDetail(hold.id), hold_seconds: HOLD_SECONDS });
  })
);

checkoutRoutes.get(
  '/holds/:id',
  wrap((req, res) => res.json({ hold: holdDetail(req.params.id) }))
);

checkoutRoutes.delete(
  '/holds/:id',
  wrap((req, res) => {
    releaseHold(req.params.id);
    res.json({ ok: true });
  })
);

// ─── Pago ────────────────────────────────────────────────────────────────────

/**
 * POST /api/holds/:id/checkout
 * body: { payment: { brand, last4 } }
 * El pago es simulado: en producción acá va el token del PSP (Mercado Pago,
 * Stripe...). Ver README → "Qué falta para producción".
 */
checkoutRoutes.post(
  '/holds/:id/checkout',
  requireUser,
  wrap((req, res) => {
    const result = checkout({
      holdId: req.params.id,
      user: req.user,
      payment: req.body.payment || {},
    });
    res.status(201).json({ ...result, order: orderView(result.code) });
  })
);

checkoutRoutes.get(
  '/orders/:code',
  wrap((req, res) => res.json(orderView(req.params.code)))
);

checkoutRoutes.post(
  '/orders/:code/refund',
  requireUser,
  wrap((req, res) => res.json(refundOrder({ orderId: req.params.code, user: req.user })))
);

checkoutRoutes.get(
  '/me/orders',
  requireUser,
  wrap((req, res) => {
    const rows = db
      .prepare(
        `SELECT o.*, e.title, e.slug, e.starts_at FROM orders o
         JOIN events e ON e.id = o.event_id
         WHERE o.user_id = ? ORDER BY o.created_at DESC`
      )
      .all(req.user.id);
    res.json({ orders: rows });
  })
);

export { bad };
