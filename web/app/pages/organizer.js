import { h, price, whenLong, toast, empty } from '../ui.js';
import { api, session } from '../api.js';

/**
 * Panel del organizador.
 *
 * Dos cosas: ver cómo va la venta y poder mover en vivo la perilla que importa
 * cuando hay quilombo (cuánta gente compra a la vez), sin tener que pedirle nada
 * a la ticketera. Abajo, el control de acceso en puerta.
 */

export async function organizerPage(ctx) {
  const user = session.user || (await ctx.requireLogin('Entrá con tu cuenta de organizador.'));
  if (!user) {
    return h('div.wrap.narrow', { style: { paddingTop: '50px' } },
      empty('Panel del organizador', 'Entrá para ver tus eventos.'));
  }

  const { events } = await api.organizerEvents();

  if (!events.length) {
    return h('div.wrap.narrow', { style: { paddingTop: '50px' } },
      empty('No tenés eventos', 'Esta cuenta no organiza ninguno. Probá con productora@trestickets.test.'));
  }

  return h('div.wrap.stack', { style: { paddingTop: '28px', '--gap': '20px' } }, [
    h('h1', 'Panel del organizador'),
    h('div.stack', { style: { '--gap': '16px' } }, events.map(eventPanel)),
    scanner(),
  ]);
}

function eventPanel(event) {
  const soldPct = event.capacity ? Math.round(((event.capacity - event.available) / event.capacity) * 100) : 0;

  const stat = (label, value, tone = '') =>
    h('div', [
      h('div', { style: { fontSize: '1.35rem', fontWeight: 640 }, class: tone }, value),
      h('div.faint', label),
    ]);

  const queueInput = h('input', {
    type: 'number',
    min: '1',
    value: String(event.queue.admitted + event.queue.waiting > 0 ? 25 : 25),
    style: { width: '90px' },
  });

  return h('div.card.stack', { style: { '--gap': '16px' } }, [
    h('div.spread', [
      h('div', [h('h2', event.title), h('div.faint', `${event.venue} · ${whenLong(event.starts_at)}`)]),
      h('div.row', [
        h('span.chip', `${soldPct}% vendido`),
        h('a.btn.small.ghost', { href: `/organizador/${event.slug}/reporte` },
          'Reporte de ventas'),
      ]),
    ]),

    h('div.row', { style: { gap: '30px' } }, [
      stat('Entradas vendidas', event.sold_count),
      stat('Disponibles', event.available),
      stat('Recaudado', price(event.gross_cents)),
      stat('En la cola', event.queue.waiting, event.queue.waiting > 0 ? 'muted' : ''),
      stat('Comprando ahora', event.queue.admitted),
    ]),

    h('table.simple', [
      h('thead', h('tr', [
        h('th', 'Categoría'),
        h('th.num', 'Precio final'),
        h('th.num', 'Vendidas'),
        h('th.num', 'Quedan'),
      ])),
      h('tbody', event.by_tier.map((t) =>
        h('tr', [
          h('td', h('div.row', { style: { gap: '8px' } }, [
            h('i.dot', { style: { background: t.color } }),
            t.name,
          ])),
          h('td.num', price(t.total_cents)),
          h('td.num', t.quantity - t.available),
          h('td.num', t.available),
        ])
      )),
    ]),

    h('details', [
      h('summary', { style: { cursor: 'pointer', color: 'var(--ink-soft)', fontSize: '0.9rem' } },
        'Ajustes en vivo'),
      h('div.row', { style: { marginTop: '12px', gap: '18px', alignItems: 'flex-end' } }, [
        h('label.field', [h('span', 'Compradores en simultáneo'), queueInput]),
        h('button.btn.small', {
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api.updateEvent(event.slug, {
                queue_capacity: Number(queueInput.value),
              });
              toast('Ajustes guardados');
            } catch (err) {
              toast(err.message || 'No pudimos guardar');
            }
            e.target.disabled = false;
          },
        }, 'Guardar'),
      ]),
      h('p.faint', { style: { marginTop: '10px' } },
        'Subir los compradores en simultáneo acorta la cola, pero aumenta el riesgo de que ' +
        'dos personas peleen por la misma butaca y una se quede afuera al pagar.'),
    ]),
  ]);
}

// ─── Control de acceso ───────────────────────────────────────────────────────

function scanner() {
  const input = h('input', {
    type: 'text',
    placeholder: 'tres://t/…',
    style: { fontFamily: 'var(--mono)', fontSize: '0.85rem' },
  });
  const result = h('div');

  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      try {
        const res = await api.scan(code);
        result.replaceChildren(
          res.valid
            ? h('div.notice.good', [
                h('strong', '✓ Puede pasar'),
                h('div', `${res.holder} — ${res.seat}`),
              ])
            : h('div.notice.bad', [h('strong', '✕ No válida'), h('div', res.reason)])
        );
      } catch (err) {
        result.replaceChildren(h('div.notice.bad', err.message || 'Código ilegible'));
      }
      input.value = '';
      input.focus();
    },
  }, [
    h('div.row', [input, h('button.btn.small', { type: 'submit' }, 'Validar')]),
  ]);

  return h('div.card.stack', { style: { '--gap': '12px' } }, [
    h('h2', 'Control de acceso'),
    h('p.muted', { style: { margin: 0, fontSize: '0.92rem' } },
      'Pegá el contenido del QR de una entrada. Cada código sirve una sola vez, y el de una ' +
      'entrada transferida queda anulado automáticamente. ' +
      'En producción esto se conecta a la cámara del teléfono del personal de puerta.'),
    form,
    result,
  ]);
}
