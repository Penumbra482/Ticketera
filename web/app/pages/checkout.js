import { h, price, countdown, toast, plural } from '../ui.js';
import { api, holdStore, session, ApiError } from '../api.js';

/**
 * Checkout de una sola pantalla.
 *
 * Nada de pasos "1 de 4". El detalle, el total y el pago están juntos, con el
 * reloj de la reserva arriba de todo para que nadie se entere tarde de que se
 * le venció. El desglose (valor + cargo de servicio) se muestra, pero el número
 * grande siempre es el que se cobra.
 */

export async function checkoutPage(ctx) {
  const { holdId } = ctx.params;
  const { hold } = await api.hold(holdId);
  const { event } = await api.event(hold.event_id);

  if (hold.status !== 'active' || hold.seconds_left <= 0) {
    return expired(event, ctx);
  }

  let secondsLeft = hold.seconds_left;
  const clock = h('strong');
  const clockBox = h('div.notice', [
    'Te guardamos los lugares por ',
    clock,
    '. Nadie más los puede comprar mientras tanto.',
  ]);

  const tick = () => {
    secondsLeft -= 1;
    clock.textContent = countdown(secondsLeft);
    if (secondsLeft <= 60) clockBox.className = 'notice bad';
    if (secondsLeft <= 0) {
      clearInterval(timer);
      holdStore.clear(event.slug);
      ctx.navigate(`/e/${event.slug}`, { replace: true });
      toast('Se venció la reserva. Elegí de nuevo tus lugares.');
    }
  };
  clock.textContent = countdown(secondsLeft);
  const timer = setInterval(tick, 1000);
  ctx.onLeave(() => clearInterval(timer));

  // ─── Resumen ───────────────────────────────────────────────────────────────

  const lines = hold.items.map((item) =>
    h('tr', [
      h('td', [
        h('div.row', { style: { gap: '8px' } }, [
          h('i.dot', { style: { background: item.color } }),
          h('span', item.tier_name),
        ]),
        h('div.faint',
          item.seat
            ? `${item.seat.section} · Fila ${item.seat.row} · Butaca ${item.seat.number}`
            : `Entrada general × ${item.quantity}`),
      ]),
      h('td.num', price(item.total_cents)),
    ])
  );

  const summary = h('div.card.stack', [
    h('h2', 'Tu compra'),
    h('div', [h('strong', event.title), h('div.faint', `${event.venue.name} · ${event.venue.city}`)]),
    h('table.simple', [
      h('tbody', lines),
      h('tfoot', [
        h('tr', [h('td.muted', 'Valor de las entradas'), h('td.num.muted', price(hold.subtotal_cents))]),
        h('tr', [h('td.muted', 'Cargo de servicio'), h('td.num.muted', price(hold.fees_cents))]),
        h('tr', [
          h('td', h('strong', 'Total')),
          h('td.num', h('strong', { style: { fontSize: '1.15rem' } }, price(hold.total_cents))),
        ]),
      ]),
    ]),
    h('p.faint', { style: { margin: 0 } },
      'Este es el mismo precio que viste al elegir tus lugares: no se agrega nada acá.'),
  ]);

  // ─── Pago ──────────────────────────────────────────────────────────────────

  const error = h('div.notice.bad', { hidden: true });
  const card = h('input', { type: 'text', inputmode: 'numeric', placeholder: '4242 4242 4242 4242', value: '4242 4242 4242 4242' });
  const expiry = h('input', { type: 'text', placeholder: '12/29', value: '12/29' });
  const cvv = h('input', { type: 'text', placeholder: '123', value: '123' });

  const form = h('form.card.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type=submit]');
      const user = await ctx.requireLogin('Necesitamos tu email para mandarte la entrada.');
      if (!user) return;

      button.disabled = true;
      error.hidden = true;
      try {
        const digits = card.value.replace(/\D/g, '');
        const res = await api.checkout(holdId, { brand: 'visa', last4: digits.slice(-4) });
        clearInterval(timer);
        holdStore.clear(event.slug);
        ctx.navigate(`/orden/${res.code}`);
      } catch (err) {
        button.disabled = false;
        error.textContent = err.message || 'No pudimos procesar el pago';
        error.hidden = false;
        if (err instanceof ApiError && err.code === 'hold_expired') {
          setTimeout(() => ctx.navigate(`/e/${event.slug}`), 1600);
        }
      }
    },
  }, [
    h('h2', 'Pago'),
    h('div.notice', 'Demostración: la tarjeta viene cargada y no se cobra nada.'),
    error,
    h('label.field', [h('span', 'Número de tarjeta'), card]),
    h('div.row', { style: { gap: '12px' } }, [
      h('label.field.grow', [h('span', 'Vencimiento'), expiry]),
      h('label.field.grow', [h('span', 'Código'), cvv]),
    ]),
    h('button.btn.block', { type: 'submit' }, `Pagar ${price(hold.total_cents)}`),
    h('p.faint', { style: { margin: 0, textAlign: 'center' } },
      `${plural(hold.items.reduce((a, i) => a + i.quantity, 0), 'entrada', 'entradas')} · ` +
      'devolución completa hasta el día del evento'),
  ]);

  const cancel = h('button.link-btn', {
    onclick: async () => {
      clearInterval(timer);
      await api.releaseHold(holdId).catch(() => {});
      holdStore.clear(event.slug);
      ctx.navigate(`/e/${event.slug}`);
    },
  }, 'Cancelar y volver a elegir');

  void session;

  return h('div.wrap.narrow.stack', { style: { paddingTop: '26px', '--gap': '16px' } }, [
    clockBox,
    summary,
    form,
    h('div', { style: { textAlign: 'center' } }, cancel),
  ]);
}

function expired(event, ctx) {
  return h('div.wrap.narrow.stack', { style: { paddingTop: '50px', textAlign: 'center' } }, [
    h('h1', 'Se venció la reserva'),
    h('p.muted', 'Los lugares volvieron al mapa para que otra persona pueda comprarlos. Podés elegir de nuevo.'),
    h('a.btn', { href: `/e/${event.slug}`, onclick: () => ctx }, 'Volver a elegir lugares'),
  ]);
}
