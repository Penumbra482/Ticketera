import { pathToFileURL } from 'node:url';

import { db, tx } from './db.js';
import { id, qrSecret, orderCode, nowIso } from './lib/util.js';
import { findOrCreateUser } from './lib/auth.js';

/**
 * Datos de ejemplo: un evento de cada tipo que nos importa.
 *
 *   1. Teatro   → sala con butacas numeradas, tres categorías, sin cola.
 *   2. Recital  → estadio, cola virtual encendida, mucha demanda.
 *   3. Indie    → club chico, entrada general, autogestionado.
 *
 * Corré `npm run reset` en /server para regenerar todo desde cero.
 */

const RESET = () => {
  for (const t of [
    'transfers', 'tickets', 'orders', 'hold_items', 'holds',
    'queue_tokens', 'ga_inventory', 'seats', 'price_tiers', 'events', 'venues',
    'sessions', 'users',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
};

const dayFromNow = (d, hour = 21) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + d);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

const insertVenue = db.prepare(
  `INSERT INTO venues (id, name, city, address, capacity, map_width, map_height, stage_json)
   VALUES (@id, @name, @city, @address, @capacity, @map_width, @map_height, @stage_json)`
);
const insertEvent = db.prepare(
  `INSERT INTO events (id, slug, title, artist, category, description, cover_color, venue_id,
                       organizer_id, starts_at, doors_at, status, seating_type, max_per_order,
                       queue_enabled, queue_capacity, admit_ttl_secs, created_at)
   VALUES (@id, @slug, @title, @artist, @category, @description, @cover_color, @venue_id,
           @organizer_id, @starts_at, @doors_at, @status, @seating_type, @max_per_order,
           @queue_enabled, @queue_capacity, @admit_ttl_secs, @created_at)`
);
const insertTier = db.prepare(
  `INSERT INTO price_tiers (id, event_id, name, kind, color, price_cents, fee_cents, sort_order)
   VALUES (@id, @event_id, @name, @kind, @color, @price_cents, @fee_cents, @sort_order)`
);
const insertSeat = db.prepare(
  `INSERT INTO seats (id, event_id, tier_id, section, row_label, seat_number, x, y, note, status)
   VALUES (@id, @event_id, @tier_id, @section, @row_label, @seat_number, @x, @y, @note, @status)`
);
const insertGa = db.prepare(
  `INSERT INTO ga_inventory (id, event_id, tier_id, quantity, held, sold)
   VALUES (?, ?, ?, ?, 0, ?)`
);

const ROW_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * Genera una sección de butacas en arco. `curve` es cuánto se levantan los
 * extremos respecto del centro: es lo que hace que el mapa se lea como una
 * sala de verdad y no como una planilla.
 */
function arcSection({ eventId, tierId, section, rows, perRow, startY, rowGap, seatGap, centerX, curve }) {
  const seats = [];
  for (let r = 0; r < rows; r++) {
    const count = typeof perRow === 'function' ? perRow(r) : perRow;
    const width = (count - 1) * seatGap;
    for (let s = 0; s < count; s++) {
      const offset = s * seatGap - width / 2;
      const bend = curve * Math.pow(offset / (width / 2 || 1), 2);
      seats.push({
        id: id('sea'),
        event_id: eventId,
        tier_id: tierId,
        section,
        row_label: ROW_LABELS[r],
        seat_number: s + 1,
        x: Number((centerX + offset).toFixed(1)),
        y: Number((startY + r * rowGap - bend).toFixed(1)),
        note: s === 0 || s === count - 1 ? (r % 7 === 0 ? 'accesible' : 'ok') : 'ok',
        status: 'available',
      });
    }
  }
  for (const seat of seats) insertSeat.run(seat);
  return seats;
}

// ─── Ventas de ejemplo ───────────────────────────────────────────────────────

/**
 * Emite entradas de verdad (orden + tickets) en vez de solo pintar butacas
 * como ocupadas. Es la única forma de que el reporte de ventas cierre: lo que
 * se ve ocupado en el mapa es exactamente lo que aparece en el reporte, con su
 * canal y su sector.
 */
const CHANNEL_MIX = [
  ['web', 0.62],        // compra por internet
  ['boleteria', 0.31],  // ventanilla del teatro
  ['cortesia', 0.07],   // prensa, invitados, canje
];

const COMP_REASONS = [
  'Prensa — nota previa',
  'Invitación producción',
  'Canje con la radio',
  'Elenco — familiares',
  'Sorteo redes',
];

function pickChannel(rand) {
  let acc = 0;
  for (const [channel, share] of CHANNEL_MIX) {
    acc += share;
    if (rand <= acc) return channel;
  }
  return 'web';
}

function seedSales({ event, tier, seats = [], quantity = 0, buyers, operator, ratio = 1 }) {
  const insertOrder = db.prepare(
    `INSERT INTO orders (id, code, event_id, user_id, kind, channel, operator_id, note,
                         subtotal_cents, fees_cents, total_cents, status,
                         payment_brand, payment_last4, created_at)
     VALUES (@id, @code, @event_id, @user_id, @kind, @channel, @operator_id, @note,
             @subtotal_cents, @fees_cents, @total_cents, @status,
             @payment_brand, @payment_last4, @created_at)`
  );
  const insertTicket = db.prepare(
    `INSERT INTO tickets (id, order_id, event_id, owner_id, seat_id, tier_id, face_cents,
                          fee_cents, holder_name, channel, qr_secret, status, created_at)
     VALUES (@id, @order_id, @event_id, @owner_id, @seat_id, @tier_id, @face_cents,
             @fee_cents, @holder_name, @channel, @qr_secret, 'valid', @created_at)`
  );

  const targets = seats.length
    ? [...seats].sort(() => Math.random() - 0.5).slice(0, Math.floor(seats.length * ratio))
    : new Array(quantity).fill(null);

  let issued = 0;
  for (const seat of targets) {
    const channel = pickChannel(Math.random());
    const isComp = channel === 'cortesia';
    const buyer = buyers[Math.floor(Math.random() * buyers.length)];
    const face = isComp ? 0 : tier.price_cents;
    const fee = isComp ? 0 : tier.fee_cents;

    const order = {
      id: id('ord'),
      code: orderCode(),
      event_id: event.id,
      user_id: buyer.id,
      kind: 'primary',
      channel,
      operator_id: channel === 'web' ? null : operator.id,
      note: isComp ? COMP_REASONS[Math.floor(Math.random() * COMP_REASONS.length)] : null,
      subtotal_cents: face,
      fees_cents: fee,
      total_cents: face + fee,
      status: 'paid',
      payment_brand: isComp ? null : channel === 'boleteria' ? 'efectivo' : 'visa',
      payment_last4: channel === 'web' ? '4242' : null,
      created_at: nowIso(),
    };
    insertOrder.run(order);
    insertTicket.run({
      id: id('tkt'),
      order_id: order.id,
      event_id: event.id,
      owner_id: buyer.id,
      seat_id: seat?.id || null,
      tier_id: tier.id,
      face_cents: face,
      fee_cents: fee,
      holder_name: buyer.name,
      channel,
      qr_secret: qrSecret(),
      created_at: nowIso(),
    });

    if (seat) db.prepare(`UPDATE seats SET status = 'sold' WHERE id = ?`).run(seat.id);
    issued++;
  }

  if (!seats.length && issued) {
    db.prepare('UPDATE ga_inventory SET sold = sold + ? WHERE event_id = ? AND tier_id = ?')
      .run(issued, event.id, tier.id);
  }
  return issued;
}

const run = () => tx(() => {
  RESET();

  const organizerUser = findOrCreateUser({
    email: 'productora@trestickets.test',
    name: 'Productora Sur',
    role: 'organizer',
  });
  const demoFan = findOrCreateUser({ email: 'fan@trestickets.test', name: 'Ana Gómez' });
  const otherFan = findOrCreateUser({ email: 'bruno@trestickets.test', name: 'Bruno Díaz' });

  // ─── 1. TEATRO ─────────────────────────────────────────────────────────────
  const teatro = {
    id: id('ven'),
    name: 'Teatro Avenida',
    city: 'Buenos Aires',
    address: 'Av. de Mayo 1222',
    capacity: 620,
    map_width: 1000,
    map_height: 760,
    stage_json: JSON.stringify({ x: 250, y: 40, w: 500, h: 56, label: 'ESCENARIO' }),
  };
  insertVenue.run(teatro);

  const obra = {
    id: id('evt'),
    slug: 'la-casa-de-los-espejos',
    title: 'La casa de los espejos',
    artist: 'Compañía Teatro Vivo',
    category: 'teatro',
    description:
      'Una obra sobre lo que heredamos sin querer. Dirigida por Marina Sosa, con seis actores en escena y sin intervalo. Duración: 95 minutos.',
    cover_color: '#a4432e',
    venue_id: teatro.id,
    organizer_id: organizerUser.id,
    starts_at: dayFromNow(21, 23),
    doors_at: dayFromNow(21, 22),
    status: 'on_sale',
    seating_type: 'reserved',
    max_per_order: 6,
    queue_enabled: 0,
    queue_capacity: 50,
    admit_ttl_secs: 600,
    created_at: nowIso(),
  };
  insertEvent.run(obra);

  const tPlatea = { id: id('tir'), event_id: obra.id, name: 'Platea', kind: 'platea', color: '#2f6f4f', price_cents: 2200000, fee_cents: 220000, sort_order: 1 };
  const tPullman = { id: id('tir'), event_id: obra.id, name: 'Pullman', kind: 'pullman', color: '#3d6ea8', price_cents: 1500000, fee_cents: 150000, sort_order: 2 };
  const tPalco = { id: id('tir'), event_id: obra.id, name: 'Palco alto', kind: 'palco', color: '#8a5cc4', price_cents: 900000, fee_cents: 90000, sort_order: 3 };
  [tPlatea, tPullman, tPalco].forEach((t) => insertTier.run(t));

  const obraPlatea = arcSection({ eventId: obra.id, tierId: tPlatea.id, section: 'Platea', rows: 10, perRow: (r) => 22 + (r % 2), startY: 190, rowGap: 34, seatGap: 30, centerX: 500, curve: 26 });
  const obraPullman = arcSection({ eventId: obra.id, tierId: tPullman.id, section: 'Pullman', rows: 6, perRow: 24, startY: 570, rowGap: 32, seatGap: 30, centerX: 500, curve: 20 });
  const obraPalcoIzq = arcSection({ eventId: obra.id, tierId: tPalco.id, section: 'Palco izq.', rows: 4, perRow: 4, startY: 220, rowGap: 40, seatGap: 32, centerX: 90, curve: 0 });
  const obraPalcoDer = arcSection({ eventId: obra.id, tierId: tPalco.id, section: 'Palco der.', rows: 4, perRow: 4, startY: 220, rowGap: 40, seatGap: 32, centerX: 910, curve: 0 });

  // ─── 2. RECITAL ────────────────────────────────────────────────────────────
  const arena = {
    id: id('ven'),
    name: 'Arena Costanera',
    city: 'Buenos Aires',
    address: 'Av. Costanera Rafael Obligado 4600',
    capacity: 1400,
    map_width: 1100,
    map_height: 820,
    stage_json: JSON.stringify({ x: 300, y: 30, w: 500, h: 70, label: 'ESCENARIO' }),
  };
  insertVenue.run(arena);

  const recital = {
    id: id('evt'),
    slug: 'nube-roja-gira-2026',
    title: 'Nube Roja — Gira 2026',
    artist: 'Nube Roja',
    category: 'musica',
    description:
      'La banda presenta su cuarto disco con banda completa y sección de vientos. Teloneros a confirmar. Apto todo público.',
    cover_color: '#c0392b',
    venue_id: arena.id,
    organizer_id: organizerUser.id,
    starts_at: dayFromNow(45, 24),
    doors_at: dayFromNow(45, 22),
    status: 'on_sale',
    seating_type: 'reserved',
    max_per_order: 4,
    queue_enabled: 1,        // alta demanda: cola virtual encendida
    queue_capacity: 25,
    admit_ttl_secs: 600,
    created_at: nowIso(),
  };
  insertEvent.run(recital);

  const rCampo = { id: id('tir'), event_id: recital.id, name: 'Campo delantero', kind: 'campo', color: '#c0392b', price_cents: 4500000, fee_cents: 450000, sort_order: 1 };
  const rPlatea = { id: id('tir'), event_id: recital.id, name: 'Platea baja', kind: 'platea', color: '#d98324', price_cents: 3200000, fee_cents: 320000, sort_order: 2 };
  const rAlta = { id: id('tir'), event_id: recital.id, name: 'Platea alta', kind: 'platea', color: '#3d6ea8', price_cents: 2100000, fee_cents: 210000, sort_order: 3 };
  const rPop = { id: id('tir'), event_id: recital.id, name: 'Popular', kind: 'popular', color: '#6b7280', price_cents: 1200000, fee_cents: 120000, sort_order: 4 };
  [rCampo, rPlatea, rAlta, rPop].forEach((t) => insertTier.run(t));

  const recCampo = arcSection({ eventId: recital.id, tierId: rCampo.id, section: 'Campo', rows: 8, perRow: 26, startY: 170, rowGap: 30, seatGap: 28, centerX: 550, curve: 18 });
  const recPlatea = arcSection({ eventId: recital.id, tierId: rPlatea.id, section: 'Platea baja', rows: 6, perRow: 30, startY: 430, rowGap: 30, seatGap: 28, centerX: 550, curve: 24 });
  const recAlta = arcSection({ eventId: recital.id, tierId: rAlta.id, section: 'Platea alta', rows: 5, perRow: 32, startY: 640, rowGap: 30, seatGap: 28, centerX: 550, curve: 28 });
  const recPopIzq = arcSection({ eventId: recital.id, tierId: rPop.id, section: 'Popular izq.', rows: 8, perRow: 5, startY: 200, rowGap: 34, seatGap: 28, centerX: 105, curve: 0 });
  const recPopDer = arcSection({ eventId: recital.id, tierId: rPop.id, section: 'Popular der.', rows: 8, perRow: 5, startY: 200, rowGap: 34, seatGap: 28, centerX: 995, curve: 0 });

  // ─── 3. INDEPENDIENTE (entrada general) ────────────────────────────────────
  const club = {
    id: id('ven'),
    name: 'Club Sótano',
    city: 'Rosario',
    address: 'Mitre 850',
    capacity: 300,
    map_width: 600,
    map_height: 400,
    stage_json: JSON.stringify({}),
  };
  insertVenue.run(club);

  const indie = {
    id: id('evt'),
    slug: 'noche-de-stand-up-sotano',
    title: 'Noche de stand up en el Sótano',
    artist: 'Ciclo Sótano',
    category: 'independiente',
    description:
      'Cinco comediantes, veinte minutos cada uno. Barra abierta hasta las 21. Entrada general de pie, capacidad limitada.',
    cover_color: '#2f6f4f',
    venue_id: club.id,
    organizer_id: organizerUser.id,
    starts_at: dayFromNow(9, 24),
    doors_at: dayFromNow(9, 23),
    status: 'on_sale',
    seating_type: 'ga',
    max_per_order: 8,
    queue_enabled: 0,
    queue_capacity: 50,
    admit_ttl_secs: 600,
    created_at: nowIso(),
  };
  insertEvent.run(indie);

  const gEarly = { id: id('tir'), event_id: indie.id, name: 'Anticipada', kind: 'general', color: '#2f6f4f', price_cents: 800000, fee_cents: 60000, sort_order: 1 };
  const gGeneral = { id: id('tir'), event_id: indie.id, name: 'General', kind: 'general', color: '#3d6ea8', price_cents: 1100000, fee_cents: 80000, sort_order: 2 };
  const gMesa = { id: id('tir'), event_id: indie.id, name: 'Mesa reservada (2 personas)', kind: 'mesa', color: '#8a5cc4', price_cents: 2600000, fee_cents: 180000, sort_order: 3 };
  [gEarly, gGeneral, gMesa].forEach((t) => insertTier.run(t));

  insertGa.run(id('gai'), indie.id, gEarly.id, 80, 0);
  insertGa.run(id('gai'), indie.id, gGeneral.id, 180, 0);
  insertGa.run(id('gai'), indie.id, gMesa.id, 20, 0);

  // ─── Ventas de ejemplo, repartidas entre canales ───────────────────────────
  // Cada entrada emitida acá es una orden real con su canal, así el reporte
  // de ventas cierra exactamente con lo que se ve ocupado en el mapa.
  const buyers = [
    demoFan,
    otherFan,
    findOrCreateUser({ email: 'carla@trestickets.test', name: 'Carla Ruiz' }),
    findOrCreateUser({ email: 'dario@trestickets.test', name: 'Darío Paz' }),
    findOrCreateUser({ email: 'elena@trestickets.test', name: 'Elena Sosa' }),
  ];
  seedSales({ event: obra, tier: tPlatea, seats: obraPlatea, ratio: 0.30, buyers, operator: organizerUser });
  seedSales({ event: obra, tier: tPullman, seats: obraPullman, ratio: 0.16, buyers, operator: organizerUser });
  seedSales({ event: obra, tier: tPalco, seats: obraPalcoIzq, ratio: 0.44, buyers, operator: organizerUser });
  seedSales({ event: obra, tier: tPalco, seats: obraPalcoDer, ratio: 0.31, buyers, operator: organizerUser });

  seedSales({ event: recital, tier: rCampo, seats: recCampo, ratio: 0.42, buyers, operator: organizerUser });
  seedSales({ event: recital, tier: rPlatea, seats: recPlatea, ratio: 0.35, buyers, operator: organizerUser });
  seedSales({ event: recital, tier: rAlta, seats: recAlta, ratio: 0.20, buyers, operator: organizerUser });
  seedSales({ event: recital, tier: rPop, seats: recPopIzq, ratio: 0.30, buyers, operator: organizerUser });
  seedSales({ event: recital, tier: rPop, seats: recPopDer, ratio: 0.30, buyers, operator: organizerUser });

  seedSales({ event: indie, tier: gEarly, quantity: 68, buyers, operator: organizerUser });
  seedSales({ event: indie, tier: gGeneral, quantity: 41, buyers, operator: organizerUser });
  seedSales({ event: indie, tier: gMesa, quantity: 6, buyers, operator: organizerUser });

  return { obra, recital, indie, demoFan, organizerUser };
});

/**
 * Carga los datos de ejemplo y cuenta lo que quedó.
 * La llama `npm run seed` y también el servidor la primera vez que arranca con
 * la base vacía, para que `npm start` alcance por sí solo.
 */
export function runSeed({ quiet = false } = {}) {
  const result = run();

  const counts = {
    eventos: db.prepare('SELECT COUNT(*) c FROM events').get().c,
    butacas: db.prepare('SELECT COUNT(*) c FROM seats').get().c,
    entradas_generales: db.prepare('SELECT COALESCE(SUM(quantity),0) c FROM ga_inventory').get().c,
    entradas_emitidas: db.prepare('SELECT COUNT(*) c FROM tickets').get().c,
  };

  const porCanal = db
    .prepare(`SELECT channel, COUNT(*) c FROM tickets GROUP BY channel ORDER BY c DESC`)
    .all();

  if (!quiet) {
    console.log('Base cargada:', counts);
    console.log('Entradas por canal:', Object.fromEntries(porCanal.map((r) => [r.channel, r.c])));
    console.log('Usuarios de prueba:');
    console.log('  fan@trestickets.test         → comprador');
    console.log('  productora@trestickets.test  → organizador (panel + escaneo en puerta)');
    console.log('Eventos:', [result.obra.slug, result.recital.slug, result.indie.slug].join(', '));
  }

  return { ...result, counts };
}

// Ejecutado directamente (`node src/seed.js`), y no importado por el servidor.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed();
}
