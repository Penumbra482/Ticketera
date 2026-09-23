import { h, price, whenLong, plural } from '../ui.js';
import { api } from '../api.js';

/** Confirmación de compra: qué compraste, dónde te sentás y dónde está tu QR. */
export async function orderPage(ctx) {
  const { order, event, tickets } = await api.order(ctx.params.code);

  return h('div.wrap.narrow.stack', { style: { paddingTop: '34px', '--gap': '18px' } }, [
    h('div.stack', { style: { textAlign: 'center', '--gap': '6px' } }, [
      h('div', { style: { fontSize: '2.4rem' } }, '✓'),
      h('h1', '¡Listo, ya tenés tus entradas!'),
      h('p.muted', `Te las mandamos por mail y ya están en tu billetera.`),
    ]),

    h('div.card.stack', { style: { '--gap': '10px' } }, [
      h('div', [
        h('strong', event.title),
        h('div.faint', `${event.venue_name} · ${event.city}`),
        h('div.faint', whenLong(event.starts_at)),
      ]),
      h('hr', { style: { border: 0, borderTop: '1px solid var(--line)' } }),
      ...tickets.map((t) =>
        h('div.spread', [
          h('div', [
            h('div.row', { style: { gap: '8px' } }, [
              h('i.dot', { style: { background: t.color } }),
              h('span', t.tier_name),
            ]),
            h('div.faint',
              t.seat
                ? `${t.seat.section} · Fila ${t.seat.row} · Butaca ${t.seat.number}`
                : 'Entrada general'),
          ]),
          h('div.right.faint', price(t.paid_cents)),
        ])
      ),
      h('hr', { style: { border: 0, borderTop: '1px solid var(--line)' } }),
      h('dl.kv', [
        h('dt', 'Código de compra'),
        h('dd', h('span.mono', order.code)),
        h('dt', 'Pagaste'),
        h('dd', h('strong', price(order.total_cents))),
        h('dt', 'Medio'),
        h('dd', `${order.payment_brand} ····${order.payment_last4}`),
      ]),
    ]),

    h('a.btn.block', { href: '/mis-entradas' },
      `Ver ${plural(tickets.length, 'mi entrada', 'mis entradas')} con el QR`),

    h('div.card.stack', { style: { '--gap': '6px' } }, [
      h('h3', 'Si al final no podés ir'),
      h('p.muted', { style: { margin: 0, fontSize: '0.92rem' } },
        'Desde tu billetera se la pasás a otra persona, gratis y en dos toques. ' +
        'O pedís la devolución completa hasta el día del evento y la ubicación vuelve ' +
        'a la venta al valor original. Sin llamar a nadie.'),
    ]),
  ]);
}
