import { h, price, whenLong, categoryLabel, plural, toast } from '../ui.js';
import { api, queueStore, holdStore, ApiError } from '../api.js';
import { seatMap } from './seatmap.js';

/**
 * Ficha del evento y elección de lugares.
 *
 * Un solo paso: elegís dónde te sentás y ves el total final abajo, siempre
 * visible. No hay pantalla intermedia de "seleccione cantidad", ni un precio
 * que cambia al final.
 */

export async function eventPage(ctx) {
  const { slug } = ctx.params;
  const [detail, seatData] = await Promise.all([api.event(slug), api.seats(slug)]);
  const { event, tiers, availability } = detail;

  // Si el evento tiene cola y todavía no tengo turno, primero paso por ahí.
  if (event.queue_enabled) {
    const saved = queueStore.get(slug);
    let ok = false;
    if (saved) {
      try {
        const status = await api.queueStatus(saved);
        ok = status.status === 'admitted';
        if (!ok && status.status === 'waiting') return waitingNotice(event, ctx);
        if (!ok) queueStore.clear(slug);
      } catch {
        queueStore.clear(slug);
      }
    }
    if (!ok) return queueGate(event, ctx);
  }

  const header = eventHeader(event, availability);

  const summary = h('div');
  const bar = h('div.sticky-bar', { hidden: true });
  const picker =
    event.seating_type === 'reserved'
      ? reservedPicker({ event, tiers, seatData, bar, summary, ctx })
      : gaPicker({ event, availability, bar, summary, ctx });

  return h('div.wrap.stack', { style: { paddingTop: '26px', '--gap': '22px' } }, [
    header,
    picker,
    bar,
    h('div.card.stack', { style: { '--gap': '8px' } }, [
      h('h2', 'Sobre el evento'),
      h('p.muted', event.description),
      h('dl.kv', [
        h('dt', 'Dónde'),
        h('dd', `${event.venue.name}, ${event.venue.address || event.venue.city}`),
        h('dt', 'Cuándo'),
        h('dd', whenLong(event.starts_at)),
        event.doors_at ? h('dt', 'Puertas') : null,
        event.doors_at ? h('dd', whenLong(event.doors_at)) : null,
        h('dt', 'Máximo por compra'),
        h('dd', plural(event.max_per_order, 'entrada', 'entradas')),
        h('dt', 'Si no podés ir'),
        h('dd', 'Se la transferís a alguien, o la devolvemos completa'),
      ]),
    ]),
  ]);
}

// ─── Encabezado ──────────────────────────────────────────────────────────────

function eventHeader(event, availability) {
  const left = availability.reduce((a, t) => a + t.available, 0);
  return h('div.stack', { style: { '--gap': '10px' } }, [
    h('div.row', { style: { gap: '6px' } }, [
      h('span.chip', categoryLabel(event.category)),
      event.queue_enabled ? h('span.chip.warn', 'Cola de espera') : null,
      left < 40 ? h('span.chip.warn', `Quedan ${left}`) : h('span.chip.ok', `${left} disponibles`),
    ]),
    h('h1', event.title),
    h('p.muted', { style: { margin: 0 } },
      `${event.artist} · ${event.venue.name}, ${event.venue.city}`),
    h('p.muted', { style: { margin: 0 } }, whenLong(event.starts_at)),
  ]);
}

// ─── Puerta de la cola ───────────────────────────────────────────────────────

function queueGate(event, ctx) {
  return h('div.wrap.narrow.stack', { style: { paddingTop: '40px', '--gap': '18px' } }, [
    h('h1', event.title),
    h('div.card.stack', [
      h('h2', 'Este evento tiene cola de espera'),
      h('p.muted',
        'Hay mucha gente comprando a la vez. La cola respeta el orden de llegada: ' +
        'una vez adentro no perdés el lugar aunque cierres la pestaña, y vas a ver ' +
        'cuántas personas tenés adelante todo el tiempo.'),
      h('button.btn', {
        onclick: async (e) => {
          e.target.disabled = true;
          const status = await api.joinQueue(event.slug);
          queueStore.set(event.slug, status.token);
          ctx.navigate(`/e/${event.slug}/cola`);
        },
      }, 'Sumarme a la cola'),
    ]),
  ]);
}

function waitingNotice(event, ctx) {
  ctx.navigate(`/e/${event.slug}/cola`, { replace: true });
  return h('div.wrap', h('p.muted', 'Volviendo a la cola…'));
}

// ─── Butacas numeradas ───────────────────────────────────────────────────────

function reservedPicker({ event, tiers, seatData, bar, summary, ctx }) {
  const map = seatMap({
    data: seatData,
    tiers,
    maxSelection: event.max_per_order,
    onChange: (selection, warning) => {
      if (warning) toast(warning);
      renderBar(selection);
    },
  });

  function renderBar(selection) {
    bar.hidden = selection.length === 0;
    if (!selection.length) return;

    const total = selection.reduce((a, s) => a + s.tier.total_cents, 0);
    bar.replaceChildren(
      h('div.spread', [
        h('div', [
          h('div', { style: { fontWeight: 600 } },
            plural(selection.length, 'butaca elegida', 'butacas elegidas')),
          h('div.faint',
            selection
              .map((s) => `${s.section} F${s.row}·${s.number}`)
              .join('  ·  ')),
        ]),
        h('div.row', [
          h('div.right', [
            h('div', { style: { fontWeight: 650, fontSize: '1.1rem' } }, price(total)),
            h('div.faint', 'Total final, cargo incluido'),
          ]),
          h('button.btn', { onclick: () => continueToCheckout(selection) }, 'Continuar'),
        ]),
      ])
    );
  }

  async function continueToCheckout(selection) {
    const button = bar.querySelector('.btn');
    button.disabled = true;
    try {
      const res = await api.holdSeats(
        event.slug,
        selection.map((s) => s.id),
        queueStore.get(event.slug)
      );
      holdStore.set(event.slug, res.hold.id);
      ctx.navigate(`/checkout/${res.hold.id}`);
    } catch (err) {
      button.disabled = false;
      if (err instanceof ApiError && err.code === 'seats_taken') {
        toast(err.message);
        map.markTaken(selection.map((s) => s.id));
        bar.hidden = true;
      } else {
        toast(err.message || 'No pudimos reservar esas butacas');
      }
    }
  }

  return h('div.stack', [
    h('div.spread', [
      h('h2', 'Elegí tus lugares'),
      h('span.faint', 'Tocá una butaca para verla y elegirla'),
    ]),
    map.node,
    summary,
  ]);
}

// ─── Entrada general ─────────────────────────────────────────────────────────

function gaPicker({ event, availability, bar, ctx }) {
  const quantities = new Map();

  function total() {
    let sum = 0;
    let count = 0;
    for (const [tierId, qty] of quantities) {
      const tier = availability.find((t) => t.tier_id === tierId);
      sum += tier.total_cents * qty;
      count += qty;
    }
    return { sum, count };
  }

  function renderBar() {
    const { sum, count } = total();
    bar.hidden = count === 0;
    if (!count) return;
    bar.replaceChildren(
      h('div.spread', [
        h('div', [
          h('div', { style: { fontWeight: 600 } }, plural(count, 'entrada', 'entradas')),
          h('div.faint', 'Entrada general, sin numerar'),
        ]),
        h('div.row', [
          h('div.right', [
            h('div', { style: { fontWeight: 650, fontSize: '1.1rem' } }, price(sum)),
            h('div.faint', 'Total final, cargo incluido'),
          ]),
          h('button.btn', { onclick: go }, 'Continuar'),
        ]),
      ])
    );
  }

  async function go(e) {
    e.target.disabled = true;
    const lines = [...quantities.entries()]
      .filter(([, q]) => q > 0)
      .map(([tier_id, quantity]) => ({ tier_id, quantity }));
    try {
      const res = await api.holdGa(event.slug, lines, queueStore.get(event.slug));
      holdStore.set(event.slug, res.hold.id);
      ctx.navigate(`/checkout/${res.hold.id}`);
    } catch (err) {
      e.target.disabled = false;
      toast(err.message || 'No pudimos reservar esas entradas');
    }
  }

  const rows = availability.map((tier) => {
    const value = h('span.mono', { style: { minWidth: '2ch', textAlign: 'center' } }, '0');

    const change = (delta) => {
      const current = quantities.get(tier.tier_id) || 0;
      const { count } = total();
      let next = current + delta;
      next = Math.max(0, Math.min(next, tier.available));
      if (delta > 0 && count >= event.max_per_order) {
        toast(`Máximo ${event.max_per_order} entradas por compra`);
        return;
      }
      quantities.set(tier.tier_id, next);
      value.textContent = String(next);
      renderBar();
    };

    return h('div.card.spread', { style: { padding: '15px 17px' } }, [
      h('div', [
        h('div.row', { style: { gap: '8px' } }, [
          h('i.dot', { style: { background: tier.color } }),
          h('strong', tier.name),
        ]),
        h('div.faint',
          tier.available > 0
            ? `${price(tier.total_cents)} final · quedan ${tier.available}`
            : 'Agotada'),
        h('div.faint', `${price(tier.face_cents)} + ${price(tier.fee_cents)} de servicio`),
      ]),
      tier.available > 0
        ? h('div.row', { style: { gap: '8px' } }, [
            h('button.btn.quiet.small', { type: 'button', 'aria-label': `Quitar ${tier.name}`, onclick: () => change(-1) }, '−'),
            value,
            h('button.btn.quiet.small', { type: 'button', 'aria-label': `Agregar ${tier.name}`, onclick: () => change(1) }, '+'),
          ])
        : h('span.chip', 'Sin stock'),
    ]);
  });

  return h('div.stack', [h('h2', 'Elegí tus entradas'), ...rows]);
}
