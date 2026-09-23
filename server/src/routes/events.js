import { Router } from '../lib/http.js';
import { db } from '../db.js';
import { wrap, notFound } from '../lib/util.js';
import { tierView } from '../lib/pricing.js';
import { availability, releaseExpired } from '../services/inventory.js';

export const events = Router();

function loadEvent(idOrSlug) {
  const row = db
    .prepare(
      `SELECT e.*, v.name AS venue_name, v.city, v.address, v.map_width, v.map_height, v.stage_json
       FROM events e JOIN venues v ON v.id = e.venue_id
       WHERE e.slug = ? OR e.id = ?`
    )
    .get(idOrSlug, idOrSlug);
  if (!row) throw notFound('Evento no encontrado');
  return row;
}

function summary(row) {
  const tiers = db
    .prepare('SELECT * FROM price_tiers WHERE event_id = ? ORDER BY sort_order')
    .all(row.id)
    .map(tierView);
  const cheapest = tiers.length ? Math.min(...tiers.map((t) => t.total_cents)) : null;
  const avail = availability(row);
  const left = avail.reduce((a, t) => a + t.available, 0);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    artist: row.artist,
    category: row.category,
    cover_color: row.cover_color,
    starts_at: row.starts_at,
    doors_at: row.doors_at,
    status: left === 0 ? 'sold_out' : row.status,
    seating_type: row.seating_type,
    queue_enabled: !!row.queue_enabled,
    venue: { name: row.venue_name, city: row.city },
    // Precio final "desde", con el cargo de servicio ya adentro.
    from_cents: cheapest,
    tickets_left: left,
  };
}

/** GET /api/events?q=&category=&city= — búsqueda simple, sin paginación por ahora. */
events.get(
  '/',
  wrap((req, res) => {
    releaseExpired();
    const { q = '', category = '', city = '' } = req.query;
    const rows = db
      .prepare(
        `SELECT e.*, v.name AS venue_name, v.city FROM events e
         JOIN venues v ON v.id = e.venue_id
         WHERE e.status != 'draft'
           AND (? = '' OR e.title LIKE '%' || ? || '%' OR e.artist LIKE '%' || ? || '%'
                       OR v.name LIKE '%' || ? || '%')
           AND (? = '' OR e.category = ?)
           AND (? = '' OR v.city = ?)
         ORDER BY e.starts_at ASC`
      )
      .all(q, q, q, q, category, category, city, city);
    res.json({ events: rows.map(summary) });
  })
);

events.get(
  '/filters',
  wrap((_req, res) => {
    const cities = db
      .prepare('SELECT DISTINCT v.city FROM venues v JOIN events e ON e.venue_id = v.id ORDER BY 1')
      .all()
      .map((r) => r.city);
    const categories = db
      .prepare(`SELECT DISTINCT category FROM events WHERE status != 'draft' ORDER BY 1`)
      .all()
      .map((r) => r.category);
    res.json({ cities, categories });
  })
);

/** GET /api/events/:slug — ficha completa con precios finales y disponibilidad. */
events.get(
  '/:slug',
  wrap((req, res) => {
    releaseExpired();
    const row = loadEvent(req.params.slug);
    const tiers = db
      .prepare('SELECT * FROM price_tiers WHERE event_id = ? ORDER BY sort_order')
      .all(row.id)
      .map(tierView);
    res.json({
      event: {
        ...summary(row),
        description: row.description,
        max_per_order: row.max_per_order,
        admit_ttl_secs: row.admit_ttl_secs,
        venue: {
          name: row.venue_name,
          city: row.city,
          address: row.address,
          map_width: row.map_width,
          map_height: row.map_height,
          stage: JSON.parse(row.stage_json || '{}'),
        },
      },
      tiers,
      availability: availability(row),
    });
  })
);

/**
 * GET /api/events/:slug/seats — el mapa completo.
 * Devolvemos coordenadas planas para que el cliente dibuje un SVG; es liviano
 * incluso con miles de butacas y permite zoom sin pedir nada al servidor.
 */
events.get(
  '/:slug/seats',
  wrap((req, res) => {
    releaseExpired();
    const row = loadEvent(req.params.slug);
    if (row.seating_type !== 'reserved')
      return res.json({ seating_type: 'ga', seats: [], sections: [] });

    const seats = db
      .prepare(
        `SELECT id, section, row_label, seat_number, x, y, tier_id, note, status
         FROM seats WHERE event_id = ? ORDER BY section, row_label, seat_number`
      )
      .all(row.id);

    const sections = [...new Set(seats.map((s) => s.section))];
    res.json({
      seating_type: 'reserved',
      map: {
        width: row.map_width,
        height: row.map_height,
        stage: JSON.parse(row.stage_json || '{}'),
      },
      sections,
      seats: seats.map((s) => ({
        id: s.id,
        section: s.section,
        row: s.row_label,
        number: s.seat_number,
        x: s.x,
        y: s.y,
        tier_id: s.tier_id,
        note: s.note,
        // 'held' y 'sold' se colapsan a 'taken': al comprador solo le importa
        // si puede sentarse ahí, y no filtramos el estado interno.
        taken: s.status !== 'available',
      })),
    });
  })
);

export { loadEvent };
