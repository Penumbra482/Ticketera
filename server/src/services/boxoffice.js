import { db, tx } from '../db.js';
import { id, qrSecret, orderCode, nowIso, bad, conflict, notFound } from '../lib/util.js';
import { findOrCreateUser } from '../lib/auth.js';

/**
 * Emisión directa por el organizador: boletería física y cortesías.
 *
 * Sin esto el reporte por canal sería decorativo: habría una columna
 * "boletería" que nunca se llena. Acá se emiten las entradas que se venden en
 * la ventanilla del teatro y las que se regalan (prensa, invitados, canje),
 * con el mismo inventario y los mismos QR que las compradas por internet.
 * Una butaca vendida en la boletería desaparece del mapa web en el acto.
 *
 * Diferencias con el checkout web:
 *   - No hay reserva previa: la persona está parada en el mostrador.
 *   - La cortesía se emite con importe 0, pero se guarda cuánto valía.
 *   - Queda registrado quién la emitió (`operator_id`) y por qué (`note`).
 */

export const CHANNELS = ['boleteria', 'cortesia'];

export function issueTickets({
  event,
  operator,
  channel,
  tierId,
  quantity = 1,
  seatIds = null,
  holderName,
  holderEmail,
  note = null,
  paymentMethod = 'efectivo',
}) {
  if (!CHANNELS.includes(channel)) throw bad('Canal inválido');

  const tier = db.prepare('SELECT * FROM price_tiers WHERE id = ? AND event_id = ?')
    .get(tierId, event.id);
  if (!tier) throw notFound('Categoría de precio no encontrada');

  const count = seatIds?.length || Number(quantity);
  if (!Number.isInteger(count) || count < 1 || count > 50)
    throw bad('Cantidad inválida (1 a 50 por operación)');

  return tx(() => {
    // Quién queda como titular. En boletería suele ser alguien sin cuenta:
    // si no hay email, la entrada se emite a nombre del comprador y se retira
    // impresa, que es exactamente como funciona hoy una ventanilla.
    const holder = holderEmail
      ? findOrCreateUser({ email: holderEmail, name: holderName || holderEmail.split('@')[0] })
      : operator;

    const seats = event.seating_type === 'reserved'
      ? pickSeats({ event, tier, seatIds, count })
      : reserveGa({ event, tier, count });

    const isComp = channel === 'cortesia';
    const faceCents = isComp ? 0 : tier.price_cents;
    const feeCents = isComp ? 0 : tier.fee_cents;

    const order = {
      id: id('ord'),
      code: orderCode(),
      event_id: event.id,
      user_id: holder.id,
      kind: 'primary',
      channel,
      operator_id: operator.id,
      note,
      subtotal_cents: faceCents * count,
      fees_cents: feeCents * count,
      total_cents: (faceCents + feeCents) * count,
      status: 'paid',
      payment_brand: isComp ? null : paymentMethod,
      payment_last4: null,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO orders (id, code, event_id, user_id, kind, channel, operator_id, note,
                           subtotal_cents, fees_cents, total_cents, status,
                           payment_brand, payment_last4, created_at)
       VALUES (@id, @code, @event_id, @user_id, @kind, @channel, @operator_id, @note,
               @subtotal_cents, @fees_cents, @total_cents, @status,
               @payment_brand, @payment_last4, @created_at)`
    ).run(order);

    const insert = db.prepare(
      `INSERT INTO tickets (id, order_id, event_id, owner_id, seat_id, tier_id, face_cents,
                            fee_cents, holder_name, channel, qr_secret, status, created_at)
       VALUES (@id, @order_id, @event_id, @owner_id, @seat_id, @tier_id, @face_cents,
               @fee_cents, @holder_name, @channel, @qr_secret, 'valid', @created_at)`
    );

    const tickets = [];
    for (let i = 0; i < count; i++) {
      const ticket = {
        id: id('tkt'),
        order_id: order.id,
        event_id: event.id,
        owner_id: holder.id,
        seat_id: seats[i]?.id || null,
        tier_id: tier.id,
        face_cents: faceCents,
        fee_cents: feeCents,
        holder_name: holderName?.trim() || holder.name,
        channel,
        qr_secret: qrSecret(),
        created_at: nowIso(),
      };
      insert.run(ticket);
      tickets.push({
        id: ticket.id,
        seat: seats[i]
          ? { section: seats[i].section, row: seats[i].row_label, number: seats[i].seat_number }
          : null,
      });
    }

    return {
      order_code: order.code,
      channel,
      count,
      total_cents: order.total_cents,
      face_value_cents: (tier.price_cents + tier.fee_cents) * count,
      tickets,
    };
  });
}

/**
 * Elige las butacas. Si el operador no indicó cuáles, toma las mejores
 * disponibles de esa categoría: fila más cercana al escenario y, dentro de la
 * fila, las más centradas — que es lo que hace un boletero a mano.
 */
function pickSeats({ event, tier, seatIds, count }) {
  let seats;

  if (seatIds?.length) {
    const placeholders = seatIds.map(() => '?').join(',');
    seats = db
      .prepare(`SELECT * FROM seats WHERE id IN (${placeholders}) AND event_id = ?`)
      .all(...seatIds, event.id);
    if (seats.length !== seatIds.length) throw notFound('Alguna butaca no existe en este evento');
    const taken = seats.filter((s) => s.status !== 'available');
    if (taken.length)
      throw conflict(
        `Ya no están disponibles: ${taken.map((s) => `${s.row_label}${s.seat_number}`).join(', ')}`,
        'seats_taken'
      );
  } else {
    const centre = db
      .prepare(`SELECT AVG(x) AS cx FROM seats WHERE tier_id = ?`)
      .get(tier.id)?.cx ?? 0;
    seats = db
      .prepare(
        `SELECT * FROM seats
         WHERE tier_id = ? AND event_id = ? AND status = 'available'
         ORDER BY row_label ASC, ABS(x - ?) ASC
         LIMIT ?`
      )
      .all(tier.id, event.id, centre, count);
    if (seats.length < count)
      throw conflict(`Quedan ${seats.length} butacas en ${tier.name}`, 'sold_out');
  }

  const mark = db.prepare(
    `UPDATE seats SET status = 'sold', hold_id = NULL WHERE id = ? AND status = 'available'`
  );
  for (const seat of seats) {
    if (mark.run(seat.id).changes !== 1)
      throw conflict('Se acaba de tomar una de las butacas', 'seats_taken');
  }
  return seats;
}

function reserveGa({ event, tier, count }) {
  const inv = db
    .prepare('SELECT * FROM ga_inventory WHERE event_id = ? AND tier_id = ?')
    .get(event.id, tier.id);
  if (!inv) throw notFound('Tipo de entrada no encontrado');
  const free = inv.quantity - inv.held - inv.sold;
  if (free < count) throw conflict(`Quedan ${free} entradas de ${tier.name}`, 'sold_out');
  db.prepare('UPDATE ga_inventory SET sold = sold + ? WHERE id = ?').run(count, inv.id);
  return [];
}
