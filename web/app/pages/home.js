import { h, price, whenShort, categoryLabel, empty } from '../ui.js';
import { api } from '../api.js';

/**
 * Portada: buscar y elegir.
 *
 * La decisión de diseño que más importa acá es que el precio que se ve en la
 * tarjeta es el precio final, cargo de servicio incluido. Si el número de la
 * grilla no es el número que se paga, todo lo demás da igual.
 */

const CATEGORIES = [
  ['', 'Todo'],
  ['musica', 'Recitales'],
  ['teatro', 'Teatro'],
  ['independiente', 'Independientes'],
];

export async function homePage() {
  const state = { q: '', category: '', city: '' };
  const results = h('div.grid');
  const count = h('p.faint');

  async function load() {
    results.replaceChildren(
      ...[0, 1, 2].map(() => h('div.skeleton', { style: { height: '210px' } }))
    );
    const { events } = await api.events(state);
    count.textContent = events.length
      ? `${events.length} ${events.length === 1 ? 'evento' : 'eventos'}`
      : '';
    results.replaceChildren(
      ...(events.length
        ? events.map(eventCard)
        : [empty('No encontramos nada con esa búsqueda', 'Probá con otro nombre o sacá los filtros.')])
    );
  }

  const search = h('input', {
    type: 'search',
    placeholder: 'Buscá un artista, una obra o una sala',
    oninput: debounce((e) => {
      state.q = e.target.value.trim();
      load();
    }, 250),
  });

  const { cities } = await api.get('/events/filters');

  const filters = h('div.row', [
    h('div.row', { style: { gap: '6px' } },
      CATEGORIES.map(([value, label]) =>
        h('button.btn.small.quiet', {
          'data-cat': value,
          onclick: (e) => {
            state.category = value;
            for (const b of filters.querySelectorAll('[data-cat]')) {
              b.classList.toggle('solid', b.dataset.cat === value);
            }
            void e;
            load();
          },
          class: value === '' ? 'solid' : '',
        }, label)
      )
    ),
    h('select', {
      style: { width: 'auto' },
      onchange: (e) => {
        state.city = e.target.value;
        load();
      },
    }, [h('option', { value: '' }, 'Todas las ciudades'), ...cities.map((c) => h('option', { value: c }, c))]),
  ]);

  load();

  return h('div.wrap.stack', { style: { paddingTop: '30px', '--gap': '20px' } }, [
    h('div.stack', { style: { '--gap': '8px' } }, [
      h('h1', 'Entradas sin vueltas'),
      h('p.muted', { style: { maxWidth: '54ch' } },
        'El precio que ves es el que pagás. La cola respeta el orden de llegada. Y si no podés ir, se la pasás a alguien o te la devolvemos completa.'),
    ]),
    h('div.card.stack', { style: { '--gap': '12px' } }, [search, filters]),
    count,
    results,
  ]);
}

function eventCard(event) {
  const soldOut = event.tickets_left === 0;
  return h('a.event-card', { href: `/e/${event.slug}` }, [
    h('div.cover', { style: { background: event.cover_color } }, event.title.slice(0, 1)),
    h('div.body', [
      h('div.row', { style: { gap: '6px' } }, [
        h('span.chip', categoryLabel(event.category)),
        event.queue_enabled ? h('span.chip.warn', 'Con cola') : null,
        soldOut ? h('span.chip', 'Agotado') : null,
      ]),
      h('h3', { style: { marginTop: '8px' } }, event.title),
      h('p.faint', { style: { margin: 0 } }, `${event.venue.name} · ${event.venue.city}`),
      h('p.faint', { style: { margin: 0 } }, whenShort(event.starts_at)),
      h('div.price', soldOut
        ? h('span.muted', 'Sin entradas')
        : [
            h('span.faint', 'Desde '),
            price(event.from_cents),
            h('span.faint', ' final'),
          ]),
    ]),
  ]);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
