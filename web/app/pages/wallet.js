import { h, price, whenLong, toast, modal, empty } from '../ui.js';
import { api, session } from '../api.js';
import { qrSvg } from '../lib/qr.js';

/**
 * Billetera de entradas.
 *
 * El QR se dibuja acá, en el navegador, a partir del código firmado que ya vino
 * con la lista: así aparece al instante y sigue funcionando sin señal, que es
 * justo cuando hace falta.
 *
 * No hay reventa: si alguien no puede ir, se la pasa a otra persona (gratis, sin
 * precio de por medio) o pide la devolución desde su compra, y la ubicación
 * vuelve al mapa al valor original. Las dos cosas se resuelven acá, sin llamar
 * por teléfono a nadie.
 */

export async function walletPage(ctx) {
  const user = session.user || (await ctx.requireLogin('Entrá para ver tus entradas.'));
  if (!user) {
    return h('div.wrap.narrow', { style: { paddingTop: '50px' } },
      empty('Entrá para ver tus entradas', 'Usamos tu email para encontrarlas.'));
  }

  const list = h('div.stack', { style: { '--gap': '18px' } });

  async function load() {
    const { tickets } = await api.wallet();
    if (!tickets.length) {
      list.replaceChildren(
        empty('Todavía no tenés entradas', 'Cuando compres, tu QR aparece acá.'),
        h('div', { style: { textAlign: 'center' } }, h('a.btn.ghost', { href: '/' }, 'Ver eventos'))
      );
      return;
    }
    list.replaceChildren(...tickets.map((t) => ticketCard(t, load, ctx)));
  }

  await load();

  return h('div.wrap.narrow.stack', { style: { paddingTop: '28px', '--gap': '18px' } }, [
    h('h1', 'Mis entradas'),
    list,
  ]);
}

function ticketCard(ticket, reload, ctx) {
  const isUsed = ticket.status === 'checked_in';

  const qr = h('div.qr', { html: qrSvg(ticket.qr_code, { ecc: 'M', margin: 2 }) });

  const actions = h('div.row', { style: { gap: '8px', marginTop: '14px' } }, [
    !isUsed
      ? h('button.btn.ghost.small', { onclick: () => transferModal(ticket, reload) }, 'Pasársela a alguien')
      : null,
    h('button.link-btn', {
      style: { marginLeft: 'auto' },
      onclick: () => ctx.navigate(`/e/${ticket.event.slug}`),
    }, 'Ver el evento'),
  ]);

  return h('div.ticket', [
    h('div.head', { style: { background: ticket.color } }, [
      h('strong', ticket.event.title),
      h('div', { style: { opacity: 0.9, fontSize: '0.88rem' } },
        `${ticket.event.venue} · ${ticket.event.city}`),
      h('div', { style: { opacity: 0.9, fontSize: '0.88rem' } }, whenLong(ticket.event.starts_at)),
    ]),

    isUsed
      ? h('div.notice.good', { style: { margin: '16px 17px' } }, 'Ya ingresaste con esta entrada.')
      : qr,

    h('div.perf'),

    h('div.meta', { style: { paddingTop: '14px' } }, [
      h('dl.kv', [
        h('dt', 'A nombre de'),
        h('dd', ticket.holder_name),
        h('dt', 'Ubicación'),
        h('dd', ticket.seat
          ? `${ticket.seat.section} · Fila ${ticket.seat.row} · Butaca ${ticket.seat.number}`
          : ticket.tier_name),
        h('dt', 'Pagaste'),
        h('dd', price(ticket.paid_cents)),
      ]),
      actions,
    ]),
  ]);
}

// ─── Transferencia ───────────────────────────────────────────────────────────

function transferModal(ticket, reload) {
  modal((close) => {
    const email = h('input', { type: 'email', required: true, placeholder: 'amigo@email.com' });
    const name = h('input', { type: 'text', placeholder: 'Nombre (opcional)' });
    const error = h('div.notice.bad', { hidden: true });

    const form = h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        const button = form.querySelector('button[type=submit]');
        button.disabled = true;
        try {
          await api.transfer(ticket.id, email.value.trim(), name.value.trim());
          close();
          toast(`Le pasamos la entrada a ${email.value.trim()}`);
          reload();
        } catch (err) {
          error.textContent = err.message || 'No pudimos transferirla';
          error.hidden = false;
          button.disabled = false;
        }
      },
    }, [
      h('h2', 'Pasarle la entrada a alguien'),
      h('p.muted', { style: { fontSize: '0.9rem' } },
        'Es gratis. La entrada pasa a su nombre y tu código deja de servir en el acto, ' +
        'así no hay confusión en la puerta.'),
      error,
      h('label.field', [h('span', 'Email de quien la recibe'), email]),
      h('label.field', [h('span', 'Nombre'), name]),
      h('div.row', [
        h('button.btn.grow', { type: 'submit' }, 'Transferir'),
        h('button.btn.ghost', { type: 'button', onclick: close }, 'Cancelar'),
      ]),
    ]);
    return form;
  });
}
