import { db, tx } from '../db.js';
import { id, qrSecret, nowIso, bad, conflict, notFound, forbidden } from '../lib/util.js';
import { findOrCreateUser } from '../lib/auth.js';

/**
 * Transferencia de una entrada a otra persona.
 *
 * Tres Tickets NO tiene reventa entre usuarios, a propósito: en cuanto existe un
 * mercado de reventa adentro de la plataforma, existe el sobreprecio, y no hay
 * tope que se sostenga cuando la demanda aprieta. Quien no puede ir tiene dos
 * caminos, los dos sin precio de por medio:
 *
 *   1. Transferirla, que es esto: la entrada pasa a nombre de otra persona,
 *      gratis, sin que cambie de manos ni un peso dentro del sistema.
 *   2. Devolverla (`services/orders.js` → `refundOrder`): se reintegra el total
 *      y la ubicación vuelve al mapa al valor original, para el que la quiera.
 *
 * En los dos casos el secreto del QR rota, así que el código anterior deja de
 * servir en el acto: no se puede "vender" una captura de pantalla.
 */

export function transferTicket({ ticketId, user, toEmail, toName }) {
  return tx(() => {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) throw notFound('Entrada no encontrada');
    if (ticket.owner_id !== user.id) throw forbidden('Esta entrada no es tuya');
    if (ticket.status !== 'valid') throw conflict('Esta entrada no se puede transferir', 'bad_status');

    const event = db.prepare('SELECT starts_at FROM events WHERE id = ?').get(ticket.event_id);
    if (new Date(event.starts_at) <= new Date()) throw bad('El evento ya empezó');

    const email = String(toEmail || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Email inválido');
    if (email === user.email) throw bad('Ya es tuya');

    const recipient = findOrCreateUser({ email, name: toName || email.split('@')[0] });

    db.prepare(
      `UPDATE tickets SET owner_id = ?, holder_name = ?, qr_secret = ? WHERE id = ?`
    ).run(recipient.id, recipient.name, qrSecret(), ticket.id);

    db.prepare(
      `INSERT INTO transfers (id, ticket_id, from_id, to_email, status, created_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`
    ).run(id('trf'), ticket.id, user.id, email, nowIso());

    return { ok: true, to: recipient.email };
  });
}
