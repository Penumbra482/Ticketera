import { Router } from '../lib/http.js';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { wrap, notFound, forbidden } from '../lib/util.js';
import { requireUser } from '../lib/auth.js';
import { transferTicket } from '../services/transfers.js';

export const tickets = Router();

/** GET /api/me/tickets — la billetera: todo junto, con el QR listo. */
tickets.get(
  '/me/tickets',
  requireUser,
  wrap((req, res) => {
    const rows = db
      .prepare(
        `SELECT t.*, e.title, e.slug, e.starts_at, e.doors_at,
                v.name AS venue_name, v.city,
                pt.name AS tier_name, pt.color,
                s.section, s.row_label, s.seat_number
         FROM tickets t
         JOIN events e ON e.id = t.event_id
         JOIN venues v ON v.id = e.venue_id
         JOIN price_tiers pt ON pt.id = t.tier_id
         LEFT JOIN seats s ON s.id = t.seat_id
         WHERE t.owner_id = ? AND t.status IN ('valid','checked_in')
         ORDER BY e.starts_at ASC`
      )
      .all(req.user.id);

    res.json({
      tickets: rows.map((t) => ({
        id: t.id,
        status: t.status,
        holder_name: t.holder_name,
        paid_cents: t.face_cents + t.fee_cents,
        face_cents: t.face_cents,
        tier_name: t.tier_name,
        color: t.color,
        seat: t.seat_id
          ? { section: t.section, row: t.row_label, number: t.seat_number }
          : null,
        event: {
          slug: t.slug,
          title: t.title,
          starts_at: t.starts_at,
          doors_at: t.doors_at,
          venue: t.venue_name,
          city: t.city,
        },
        // Viene con la billetera para que el QR se dibuje sin otro viaje al servidor.
        qr_code: signTicket(t),
      })),
    });
  })
);

/**
 * GET /api/tickets/:id/code — el contenido del QR, firmado.
 *
 * Devolvemos el texto y no una imagen: el navegador dibuja el QR con el
 * módulo `web/app/lib/qr.js`, así la entrada se ve al instante y también
 * sin conexión, que es exactamente el momento en que hace falta (una fila en
 * la puerta, sin señal). El secreto va adentro y rota en cada transferencia o
 * reventa, así que una captura de pantalla vieja no sirve.
 */
tickets.get(
  '/tickets/:id/code',
  requireUser,
  wrap((req, res) => {
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
    if (!t) throw notFound('Entrada no encontrada');
    if (t.owner_id !== req.user.id) throw forbidden('Esta entrada no es tuya');
    res.set('Cache-Control', 'no-store').json({ code: signTicket(t) });
  })
);

export function signTicket(t) {
  const payload = `${t.id}.${t.qr_secret}`;
  const sig = crypto
    .createHmac('sha256', process.env.TT_QR_SECRET || 'tres-tickets-dev-secret')
    .update(payload)
    .digest('base64url')
    .slice(0, 12);
  return `tres://t/${payload}.${sig}`;
}

// ─── Transferencia ───────────────────────────────────────────────────────────

tickets.post(
  '/tickets/:id/transfer',
  requireUser,
  wrap((req, res) =>
    res.json(
      transferTicket({
        ticketId: req.params.id,
        user: req.user,
        toEmail: req.body.email,
        toName: req.body.name,
      })
    )
  )
);

