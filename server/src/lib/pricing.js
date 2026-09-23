/**
 * Precio final desde el primer momento.
 *
 * La queja número uno contra las ticketeras tradicionales es el precio que
 * cambia al llegar al último paso. Acá el backend nunca devuelve un precio
 * "desnudo": cada tier expone `total_cents` (facial + cargo de servicio) y el
 * frontend muestra ese número en la grilla, en el mapa y en el checkout.
 * El desglose se muestra al lado, no escondido.
 */

export function tierView(tier) {
  return {
    id: tier.id,
    name: tier.name,
    color: tier.color,
    face_cents: tier.price_cents,
    fee_cents: tier.fee_cents,
    total_cents: tier.price_cents + tier.fee_cents,
    sort_order: tier.sort_order,
  };
}

export function formatArs(cents) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Suma de un carrito de items {tier, quantity}. */
export function totals(items) {
  let subtotal = 0;
  let fees = 0;
  for (const { tier, quantity } of items) {
    subtotal += tier.price_cents * quantity;
    fees += tier.fee_cents * quantity;
  }
  return { subtotal_cents: subtotal, fees_cents: fees, total_cents: subtotal + fees };
}
