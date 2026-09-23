import { db } from '../db.js';

/**
 * Reporte de ventas discriminado.
 *
 * El reporte de una ticketera tradicional dice "vendiste 812 entradas y
 * recaudaste tanto". Eso no sirve para decidir nada. Las preguntas reales del
 * que produce un evento son otras:
 *
 *   ¿los palcos se están vendiendo o solo la platea barata?
 *   ¿cuánto se vendió en la boletería del teatro y cuánto por internet?
 *   ¿cuántas entradas regalamos y cuánto dejamos de facturar por eso?
 *
 * Por eso acá cada entrada emitida se clasifica por DOS ejes independientes:
 *
 *   - SECTOR  (`price_tiers.kind`): palco, platea, pullman, campo, popular,
 *     mesa, general. Es el tipo de ubicación, no el nombre comercial: "Platea
 *     baja" y "Platea alta" son dos categorías de precio pero un solo sector,
 *     y eso permite comparar entre eventos y entre salas.
 *   - CANAL   (`tickets.channel`): web, boletería y cortesía.
 *
 * Y se cruzan: "cuántos palcos se vendieron en boletería" es una celda de la
 * matriz, no una consulta nueva.
 *
 * Las cortesías cuentan como ubicación ocupada pero nunca como recaudación; se
 * informa aparte cuánto habrían valido, porque regalar cien entradas es una
 * decisión legítima y no verla en ningún lado no lo es.
 */

export const SECTOR_LABELS = {
  palco: 'Palcos',
  platea: 'Plateas',
  pullman: 'Pullman',
  campo: 'Campo',
  popular: 'Populares',
  mesa: 'Mesas',
  general: 'Entrada general',
  otro: 'Otros',
};

export const CHANNEL_LABELS = {
  web: 'Compra virtual',
  boleteria: 'Boletería física',
  cortesia: 'Cortesías',
};

export const SECTOR_ORDER = Object.keys(SECTOR_LABELS);
export const CHANNEL_ORDER = Object.keys(CHANNEL_LABELS);

export function salesReport(event) {
  const rows = db
    .prepare(
      `SELECT t.channel,
              t.status,
              t.face_cents,
              t.fee_cents,
              pt.id   AS tier_id,
              pt.name AS tier_name,
              pt.kind AS sector,
              pt.color,
              pt.sort_order
       FROM tickets t
       JOIN price_tiers pt ON pt.id = t.tier_id
       WHERE t.event_id = ?`
    )
    .all(event.id);

  const capacity = capacityByTier(event);

  // ─── Acumuladores ──────────────────────────────────────────────────────────
  const bySector = new Map();
  const byChannel = new Map();
  const byTier = new Map();
  const matrix = new Map(); // `${sector}|${channel}` → { count, amount }

  const totals = {
    issued: 0,           // en circulación
    revenue_cents: 0,    // recaudado, cargo de servicio incluido
    face_cents: 0,
    fees_cents: 0,
    comp_count: 0,       // cortesías
    comp_value_cents: 0, // lo que habrían costado
    refunded_count: 0,
    refunded_cents: 0,
  };

  const bump = (map, key, seed) => {
    if (!map.has(key)) map.set(key, { ...seed });
    return map.get(key);
  };

  for (const row of rows) {
    const sector = SECTOR_LABELS[row.sector] ? row.sector : 'otro';
    const paid = row.face_cents + row.fee_cents;
    const circulating = ['valid', 'checked_in'].includes(row.status);

    if (row.status === 'refunded') {
      totals.refunded_count++;
      totals.refunded_cents += paid;
    }

    if (circulating) {
      totals.issued++;

      const s = bump(bySector, sector, { sector, issued: 0, revenue_cents: 0, comp_count: 0 });
      s.issued++;

      const c = bump(byChannel, row.channel, { channel: row.channel, issued: 0, revenue_cents: 0 });
      c.issued++;

      const t = bump(byTier, row.tier_id, {
        tier_id: row.tier_id,
        name: row.tier_name,
        sector,
        color: row.color,
        sort_order: row.sort_order,
        issued: 0,
        revenue_cents: 0,
        comp_count: 0,
      });
      t.issued++;

      const cell = bump(matrix, `${sector}|${row.channel}`, { count: 0, amount_cents: 0 });
      cell.count++;
      cell.amount_cents += row.channel === 'cortesia' ? 0 : paid;

      if (row.channel === 'cortesia') {
        totals.comp_count++;
        // Valor de referencia: lo que esa ubicación cuesta al público.
        totals.comp_value_cents += capacity.price.get(row.tier_id) || 0;
        s.comp_count++;
        t.comp_count++;
      }
    }

    if (row.status !== 'refunded' && ['web', 'boleteria'].includes(row.channel)) {
      totals.revenue_cents += paid;
      totals.face_cents += row.face_cents;
      totals.fees_cents += row.fee_cents;
      if (circulating) {
        bySector.get(sector).revenue_cents += paid;
        byChannel.get(row.channel).revenue_cents += paid;
        byTier.get(row.tier_id).revenue_cents += paid;
      }
    }
  }

  // ─── Salida ordenada y completa (los ceros también informan) ───────────────
  const sectors = SECTOR_ORDER.filter(
    (k) => bySector.has(k) || capacity.bySector.has(k)
  ).map((k) => {
    const found = bySector.get(k) || { issued: 0, revenue_cents: 0, comp_count: 0 };
    const cap = capacity.bySector.get(k) || { quantity: 0, available: 0 };
    return {
      sector: k,
      label: SECTOR_LABELS[k],
      issued: found.issued,
      revenue_cents: found.revenue_cents,
      comp_count: found.comp_count,
      capacity: cap.quantity,
      available: cap.available,
      sell_through: cap.quantity ? found.issued / cap.quantity : 0,
    };
  });

  const channels = CHANNEL_ORDER.map((k) => {
    const found = byChannel.get(k) || { issued: 0, revenue_cents: 0 };
    return {
      channel: k,
      label: CHANNEL_LABELS[k],
      issued: found.issued,
      revenue_cents: found.revenue_cents,
      share: totals.issued ? found.issued / totals.issued : 0,
    };
  });

  return {
    event: {
      id: event.id,
      slug: event.slug,
      title: event.title,
      starts_at: event.starts_at,
      seating_type: event.seating_type,
    },
    generated_at: new Date().toISOString(),
    totals: {
      ...totals,
      capacity: capacity.total,
      available: capacity.available,
      sell_through: capacity.total ? totals.issued / capacity.total : 0,
      average_cents: totals.issued - totals.comp_count > 0
        ? Math.round(totals.revenue_cents / (totals.issued - totals.comp_count))
        : 0,
    },
    sectors,
    channels,
    matrix: sectors.map((s) => ({
      sector: s.sector,
      label: s.label,
      cells: CHANNEL_ORDER.map((c) => ({
        channel: c,
        ...(matrix.get(`${s.sector}|${c}`) || { count: 0, amount_cents: 0 }),
      })),
      total: CHANNEL_ORDER.reduce(
        (acc, c) => {
          const cell = matrix.get(`${s.sector}|${c}`) || { count: 0, amount_cents: 0 };
          acc.count += cell.count;
          acc.amount_cents += cell.amount_cents;
          return acc;
        },
        { count: 0, amount_cents: 0 }
      ),
    })),
    tiers: [...byTier.values()].sort((a, b) => a.sort_order - b.sort_order),
  };
}

/** Capacidad y disponibilidad por categoría y por sector. */
function capacityByTier(event) {
  const rows =
    event.seating_type === 'ga'
      ? db
          .prepare(
            `SELECT pt.id AS tier_id, pt.kind AS sector, pt.price_cents, pt.fee_cents,
                    gi.quantity AS quantity,
                    (gi.quantity - gi.held - gi.sold) AS available
             FROM ga_inventory gi JOIN price_tiers pt ON pt.id = gi.tier_id
             WHERE gi.event_id = ?`
          )
          .all(event.id)
      : db
          .prepare(
            `SELECT pt.id AS tier_id, pt.kind AS sector, pt.price_cents, pt.fee_cents,
                    COUNT(s.id) AS quantity,
                    SUM(CASE WHEN s.status = 'available' THEN 1 ELSE 0 END) AS available
             FROM price_tiers pt LEFT JOIN seats s ON s.tier_id = pt.id
             WHERE pt.event_id = ? GROUP BY pt.id`
          )
          .all(event.id);

  const bySector = new Map();
  const price = new Map();
  let total = 0;
  let available = 0;

  for (const row of rows) {
    const sector = SECTOR_LABELS[row.sector] ? row.sector : 'otro';
    const entry = bySector.get(sector) || { quantity: 0, available: 0 };
    entry.quantity += row.quantity || 0;
    entry.available += row.available || 0;
    bySector.set(sector, entry);
    price.set(row.tier_id, row.price_cents + row.fee_cents);
    total += row.quantity || 0;
    available += row.available || 0;
  }

  return { bySector, price, total, available };
}

/**
 * El mismo reporte en CSV, para pegarlo en una planilla.
 * Formato con `;` y coma decimal: es lo que Excel en español abre sin pelear.
 */
export function reportCsv(report) {
  const money = (cents) => (cents / 100).toFixed(2).replace('.', ',');
  const pct = (n) => (n * 100).toFixed(1).replace('.', ',');
  const out = [];

  out.push(`Reporte de ventas;${report.event.title}`);
  out.push(`Generado;${new Date(report.generated_at).toLocaleString('es-AR')}`);
  out.push('');

  out.push('RESUMEN');
  out.push('Concepto;Cantidad;Importe');
  out.push(`Entradas en circulación;${report.totals.issued};${money(report.totals.revenue_cents)}`);
  out.push(`Cortesías;${report.totals.comp_count};${money(report.totals.comp_value_cents)}`);
  out.push(`Devoluciones;${report.totals.refunded_count};${money(report.totals.refunded_cents)}`);
  out.push(`Capacidad;${report.totals.capacity};`);
  out.push(`Disponibles;${report.totals.available};`);
  out.push(`Ocupación;${pct(report.totals.sell_through)}%;`);
  out.push('');

  out.push('POR SECTOR');
  out.push('Sector;Emitidas;Cortesías;Capacidad;Disponibles;Ocupación;Recaudado');
  for (const s of report.sectors) {
    out.push(
      `${s.label};${s.issued};${s.comp_count};${s.capacity};${s.available};${pct(s.sell_through)}%;${money(s.revenue_cents)}`
    );
  }
  out.push('');

  out.push('POR CANAL');
  out.push('Canal;Emitidas;Participación;Importe');
  for (const c of report.channels) {
    out.push(`${c.label};${c.issued};${pct(c.share)}%;${money(c.revenue_cents)}`);
  }
  out.push('');

  out.push('SECTOR POR CANAL (cantidad de entradas)');
  out.push(['Sector', ...CHANNEL_ORDER.map((c) => CHANNEL_LABELS[c]), 'Total'].join(';'));
  for (const row of report.matrix) {
    out.push([row.label, ...row.cells.map((c) => c.count), row.total.count].join(';'));
  }
  out.push('');

  out.push('SECTOR POR CANAL (importe)');
  out.push(['Sector', ...CHANNEL_ORDER.map((c) => CHANNEL_LABELS[c]), 'Total'].join(';'));
  for (const row of report.matrix) {
    out.push(
      [row.label, ...row.cells.map((c) => money(c.amount_cents)), money(row.total.amount_cents)].join(';')
    );
  }
  out.push('');

  out.push('POR CATEGORÍA DE PRECIO');
  out.push('Categoría;Sector;Emitidas;Cortesías;Recaudado');
  for (const t of report.tiers) {
    out.push(
      `${t.name};${SECTOR_LABELS[t.sector]};${t.issued};${t.comp_count};${money(t.revenue_cents)}`
    );
  }

  // BOM para que Excel reconozca UTF-8 y no rompa los acentos.
  return '﻿' + out.join('\r\n') + '\r\n';
}
