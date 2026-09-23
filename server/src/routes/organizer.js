import { Router } from '../lib/http.js';
import { db } from '../db.js';
import { wrap, notFound, forbidden, bad } from '../lib/util.js';
import { requireUser } from '../lib/auth.js';
import { availability } from '../services/inventory.js';
import { salesReport, reportCsv } from '../services/reports.js';
import { issueTickets } from '../services/boxoffice.js';

export const organizer = Router();

/** Carga el evento y verifica que quien pregunta sea su organizador. */
function ownedEvent(req) {
  const event = db
    .prepare('SELECT * FROM events WHERE slug = ? OR id = ?')
    .get(req.params.id, req.params.id);
  if (!event) throw notFound('Evento no encontrado');
  if (event.organizer_id !== req.user.id) throw forbidden('No sos el organizador de este evento');
  return event;
}

/** Panel del organizador: cuánto vendí, cuánto queda, cómo va la cola. */
organizer.get(
  '/organizer/events',
  requireUser,
  wrap((req, res) => {
    const rows = db
      .prepare(
        `SELECT e.*, v.name AS venue_name FROM events e
         JOIN venues v ON v.id = e.venue_id
         WHERE e.organizer_id = ? ORDER BY e.starts_at`
      )
      .all(req.user.id);

    res.json({
      events: rows.map((e) => {
        const avail = availability(e);
        // Lo recaudado sale de las entradas realmente emitidas por Tres Tickets; la
        // cantidad vendida sale del inventario, que también contempla lo que
        // se haya vendido por otro canal.
        const issued = db
          .prepare(
            `SELECT COALESCE(SUM(face_cents),0) AS gross
             FROM tickets WHERE event_id = ? AND status IN ('valid','checked_in')`
          )
          .get(e.id);
        const queue = db
          .prepare(
            `SELECT
               SUM(CASE WHEN status='waiting' THEN 1 ELSE 0 END) AS waiting,
               SUM(CASE WHEN status='admitted' THEN 1 ELSE 0 END) AS admitted
             FROM queue_tokens WHERE event_id = ?`
          )
          .get(e.id);
        const capacity = avail.reduce((a, t) => a + t.quantity, 0);
        const available = avail.reduce((a, t) => a + t.available, 0);

        return {
          id: e.id,
          slug: e.slug,
          title: e.title,
          starts_at: e.starts_at,
          venue: e.venue_name,
          capacity,
          available,
          sold_count: capacity - available,
          gross_cents: issued.gross,
          queue: { waiting: queue?.waiting || 0, admitted: queue?.admitted || 0 },
          by_tier: avail,
        };
      }),
    });
  })
);

// ─── Reporte de ventas ───────────────────────────────────────────────────────

/**
 * GET /api/organizer/events/:id/report
 * Ventas discriminadas por sector (palcos, plateas, campo…) y por canal
 * (compra virtual, boletería física y cortesías), y el cruce de ambos.
 */
organizer.get(
  '/organizer/events/:id/report',
  requireUser,
  wrap((req, res) => res.json(salesReport(ownedEvent(req))))
);

/** El mismo reporte en CSV, para abrirlo en una planilla. */
organizer.get(
  '/organizer/events/:id/report.csv',
  requireUser,
  wrap((req, res) => {
    const event = ownedEvent(req);
    const csv = reportCsv(salesReport(event));
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="ventas-${event.slug}.csv"`)
      .send(csv);
  })
);

// ─── Emisión directa: boletería y cortesías ──────────────────────────────────

/**
 * POST /api/organizer/events/:id/issue
 * body: { channel: 'boleteria'|'cortesia', tier_id, quantity, seat_ids?,
 *         holder_name?, holder_email?, note?, payment_method? }
 */
organizer.post(
  '/organizer/events/:id/issue',
  requireUser,
  wrap((req, res) => {
    const event = ownedEvent(req);
    const { channel, tier_id, quantity, seat_ids, holder_name, holder_email, note, payment_method } =
      req.body || {};
    if (channel === 'cortesia' && !String(note || '').trim())
      throw bad('Indicá el motivo de la cortesía (prensa, invitado, canje…)');

    res.status(201).json(
      issueTickets({
        event,
        operator: req.user,
        channel,
        tierId: tier_id,
        quantity,
        seatIds: seat_ids,
        holderName: holder_name,
        holderEmail: holder_email,
        note,
        paymentMethod: payment_method,
      })
    );
  })
);

/** Ajustes en vivo: cola, máximo por compra y estado de la venta. */
organizer.patch(
  '/organizer/events/:id',
  requireUser,
  wrap((req, res) => {
    const e = ownedEvent(req);

    const fields = ['queue_enabled', 'queue_capacity', 'admit_ttl_secs', 'max_per_order', 'status'];
    const updates = [];
    const values = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(typeof req.body[f] === 'boolean' ? (req.body[f] ? 1 : 0) : req.body[f]);
      }
    }
    if (!updates.length) return res.json({ ok: true, updated: 0 });
    db.prepare(`UPDATE events SET ${updates.join(', ')} WHERE id = ?`).run(...values, e.id);
    res.json({ ok: true, updated: updates.length });
  })
);

/** Control de acceso en puerta: valida el QR y marca el ingreso. */
organizer.post(
  '/organizer/scan',
  requireUser,
  wrap((req, res) => {
    const raw = String(req.body.code || '');
    const m = raw.match(/^tres:\/\/t\/([^.]+)\.([^.]+)\.([^.]+)$/);
    if (!m) return res.status(400).json({ valid: false, reason: 'Código ilegible' });
    const [, ticketId, secret] = m;

    const t = db
      .prepare(
        `SELECT t.*, e.organizer_id, e.title, s.section, s.row_label, s.seat_number
         FROM tickets t JOIN events e ON e.id = t.event_id
         LEFT JOIN seats s ON s.id = t.seat_id WHERE t.id = ?`
      )
      .get(ticketId);

    if (!t) return res.status(404).json({ valid: false, reason: 'Entrada inexistente' });
    if (t.organizer_id !== req.user.id) throw forbidden('No sos el organizador de este evento');
    if (t.qr_secret !== secret)
      return res.json({ valid: false, reason: 'Código vencido: la entrada se transfirió' });
    if (t.status === 'checked_in')
      return res.json({ valid: false, reason: 'Ya ingresó', holder: t.holder_name });
    if (t.status !== 'valid') return res.json({ valid: false, reason: `Entrada ${t.status}` });

    db.prepare(`UPDATE tickets SET status = 'checked_in' WHERE id = ?`).run(t.id);
    res.json({
      valid: true,
      holder: t.holder_name,
      event: t.title,
      seat: t.seat_id ? `${t.section} · Fila ${t.row_label} · Butaca ${t.seat_number}` : 'Entrada general',
    });
  })
);
