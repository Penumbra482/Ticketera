import { h, price, whenLong, toast, empty, plural } from '../ui.js';
import { api, session } from '../api.js';
import { shareBar, legend, stackedRows, attachTooltips, formatPct } from '../charts.js';

/**
 * Reporte de ventas discriminado.
 *
 * El reporte típico de una ticketera es una sola fila: "vendiste X, recaudaste
 * Y". Con eso no se decide nada. Acá cada entrada se clasifica por dos ejes que
 * responden preguntas distintas:
 *
 *   SECTOR → ¿qué parte de la sala se está vendiendo? Si los palcos van al 30%
 *            y la platea al 90%, hay que mover el precio de los palcos, no
 *            hacer más publicidad.
 *   CANAL  → ¿por dónde entra la venta? Si la boletería física es el 40%, el
 *            horario de la ventanilla es una decisión de negocio.
 *
 * Cada eje se muestra dos veces a propósito: como gráfico, para ver la
 * proporción de un vistazo, y como tabla, para leer el número exacto y para
 * que funcione con lector de pantalla. El cruce de los dos ejes es el gráfico
 * que más dice: una barra por sector, todas al 100%, para ver si la mezcla de
 * canales cambia entre los palcos y la platea.
 *
 * Las cortesías se muestran siempre por separado y nunca suman a lo recaudado,
 * pero sí se informa cuánto habrían valido: regalar cien entradas es una
 * decisión legítima, no verla en ningún lado no lo es.
 */

const SECTION_GAP = { '--gap': '14px' };

/** Color por canal. Es el mismo en todos los gráficos: el color sigue a la
 *  entidad, nunca a su posición en un ranking. */
const CHANNEL_COLOR = {
  web: 'var(--ch-web)',
  boleteria: 'var(--ch-boleteria)',
  cortesia: 'var(--ch-cortesia)',
};

/** Tinta del porcentaje escrito adentro de cada segmento. */
const CHANNEL_INK = {
  web: 'var(--ch-web-ink)',
  boleteria: 'var(--ch-boleteria-ink)',
  cortesia: 'var(--ch-cortesia-ink)',
};

/** Escala de un solo tono para los sectores, del más grande al más chico. */
const rampStep = (index) => Math.min(7, index + 1);

export async function reportPage(ctx) {
  const { slug } = ctx.params;
  const user = session.user || (await ctx.requireLogin('Entrá con tu cuenta de organizador.'));
  if (!user) {
    return h('div.wrap.narrow', { style: { paddingTop: '50px' } },
      empty('Reporte de ventas', 'Entrá para verlo.'));
  }

  const report = await api.report(slug);

  const page = h('div.wrap.stack', { style: { paddingTop: '26px', '--gap': '26px', position: 'relative' } }, [
    header(report, slug),
    summary(report),
    sectorSection(report),
    channelSection(report),
    matrixSection(report),
    tierSection(report),
    issueSection(report, slug, () => ctx.navigate(`/organizador/${slug}/reporte`)),
  ]);

  return attachTooltips(page);
}

// ─── Encabezado ──────────────────────────────────────────────────────────────

function header(report, slug) {
  return h('div.spread', [
    h('div', [
      h('p.faint', { style: { margin: 0 } }, 'Reporte de ventas'),
      h('h1', report.event.title),
      h('p.muted', { style: { margin: 0 } }, whenLong(report.event.starts_at)),
    ]),
    h('div.row', [
      h('a.btn.ghost.small', { href: '/organizador' }, 'Volver al panel'),
      h('button.btn.small', {
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.downloadReport(slug);
          } catch (err) {
            toast(err.message || 'No pudimos generar el CSV');
          }
          e.target.disabled = false;
        },
      }, 'Descargar CSV'),
    ]),
  ]);
}

// ─── Resumen ─────────────────────────────────────────────────────────────────

function summary(report) {
  const t = report.totals;
  const tile = (label, value, detail) =>
    h('div.card', { style: { padding: '15px 17px' } }, [
      h('div.faint', label),
      h('div', { style: { fontSize: '1.5rem', fontWeight: 650, marginTop: '2px' } }, value),
      detail ? h('div.faint', detail) : null,
    ]);

  return h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' } }, [
    tile('Entradas en circulación', t.issued, `sobre ${t.capacity} de capacidad`),
    tile('Ocupación', formatPct(t.sell_through * 100), `${t.available} disponibles`),
    tile('Recaudado', price(t.revenue_cents), `${price(t.fees_cents)} de cargo de servicio`),
    tile('Ticket promedio', price(t.average_cents), 'sin contar cortesías'),
    tile('Cortesías', t.comp_count, `valor de referencia ${price(t.comp_value_cents)}`),
  ]);
}

// ─── Por sector ──────────────────────────────────────────────────────────────

function sectorSection(report) {
  // Ordenados de mayor a menor: la escala de color acompaña el tamaño, así el
  // gráfico se lee incluso en blanco y negro.
  const ranked = [...report.sectors].sort((a, b) => b.issued - a.issued);
  const segments = ranked.map((s, i) => ({
    key: s.sector,
    label: s.label,
    value: s.issued,
    color: `var(--ramp-${rampStep(i)})`,
    ink: `var(--ramp-${rampStep(i)}-ink)`,
  }));

  return h('div.stack', { style: SECTION_GAP }, [
    h('div.spread', [
      h('h2', 'Por sector'),
      h('span.faint', 'Palcos, plateas, campo, populares… tipo de ubicación'),
    ]),

    h('div.card.stack', { style: { '--gap': '13px' } }, [
      h('p.faint', { style: { margin: 0 } },
        `Cómo se reparten las ${plural(report.totals.issued, 'entrada emitida', 'entradas emitidas')} entre los sectores de la sala`),
      shareBar(segments),
      legend(segments),
    ]),

    h('div.card', { style: { padding: '6px 4px', overflowX: 'auto' } },
      h('table.simple', [
        h('thead', h('tr', [
          h('th', 'Sector'),
          h('th.num', 'Emitidas'),
          h('th.num', '% del total'),
          h('th.num', 'Cortesías'),
          h('th.num', 'Capacidad'),
          h('th.num', 'Disponibles'),
          h('th', 'Ocupación'),
          h('th.num', 'Recaudado'),
        ])),
        h('tbody', report.sectors.map((s) =>
          h('tr', [
            h('td', h('strong', s.label)),
            h('td.num', s.issued),
            h('td.num', formatPct(report.totals.issued ? (s.issued / report.totals.issued) * 100 : 0)),
            h('td.num', s.comp_count ? h('span.muted', s.comp_count) : h('span.faint', '—')),
            h('td.num', s.capacity),
            h('td.num', s.available),
            h('td', { style: { width: '170px' } }, occupancy(s.sell_through)),
            h('td.num', price(s.revenue_cents)),
          ])
        )),
      ])
    ),
  ]);
}

/** Medidor de ocupación: una sola serie contra su límite, con el número al lado
 *  porque una barra sola no se puede leer con precisión. */
function occupancy(ratio) {
  const value = Math.round(ratio * 100);
  return h('div.row', { style: { gap: '9px', flexWrap: 'nowrap' } }, [
    h('div.progress', { style: { flex: 1, minWidth: '64px' } },
      h('i', { style: { width: `${Math.min(100, value)}%` } })),
    h('span.faint', { style: { minWidth: '3.5ch', textAlign: 'right' } }, `${value}%`),
  ]);
}

// ─── Por canal ───────────────────────────────────────────────────────────────

function channelSection(report) {
  const segments = report.channels.map((c) => ({
    key: c.channel,
    label: c.label,
    value: c.issued,
    color: CHANNEL_COLOR[c.channel],
    ink: CHANNEL_INK[c.channel],
  }));

  return h('div.stack', { style: SECTION_GAP }, [
    h('div.spread', [
      h('h2', 'Por canal'),
      h('span.faint', 'Cómo llegó cada entrada a manos del público'),
    ]),

    h('div.card.stack', { style: { '--gap': '13px' } }, [
      shareBar(segments),
      legend(segments),
    ]),

    h('div.card', { style: { padding: '6px 4px', overflowX: 'auto' } },
      h('table.simple', [
        h('thead', h('tr', [
          h('th', 'Canal'),
          h('th.num', 'Emitidas'),
          h('th.num', 'Participación'),
          h('th.num', 'Importe'),
        ])),
        h('tbody', report.channels.map((c) =>
          h('tr', [
            h('td', h('div.row', { style: { gap: '9px' } }, [
              h('i.swatch', {
                style: { background: CHANNEL_COLOR[c.channel], width: '11px', height: '11px', borderRadius: '3px' },
              }),
              h('strong', c.label),
              c.channel === 'cortesia' ? h('span.chip', 'no suma a lo recaudado') : null,
            ])),
            h('td.num', c.issued),
            h('td.num', formatPct(c.share * 100)),
            h('td.num', c.channel === 'cortesia' ? h('span.faint', '—') : price(c.revenue_cents)),
          ])
        )),
      ])
    ),
  ]);
}

// ─── Cruce sector × canal ────────────────────────────────────────────────────

function matrixSection(report) {
  const rows = report.matrix
    .filter((row) => row.total.count > 0)
    .map((row) => ({
      label: row.label,
      segments: row.cells.map((cell) => ({
        key: cell.channel,
        label: `${row.label} · ${channelLabel(report, cell.channel)}`,
        value: cell.count,
        color: CHANNEL_COLOR[cell.channel],
        ink: CHANNEL_INK[cell.channel],
      })),
    }));

  let showAmounts = false;
  const body = h('tbody');

  const paint = () => {
    body.replaceChildren(
      ...report.matrix.map((row) =>
        h('tr', [
          h('td', h('strong', row.label)),
          ...row.cells.map((cell) =>
            h('td.num',
              cell.count === 0
                ? h('span.faint', '—')
                : showAmounts
                  ? price(cell.amount_cents)
                  : h('span', [
                      `${cell.count}`,
                      h('span.faint', { style: { marginLeft: '7px' } },
                        formatPct(row.total.count ? (cell.count / row.total.count) * 100 : 0)),
                    ]))
          ),
          h('td.num', h('strong', showAmounts ? price(row.total.amount_cents) : row.total.count)),
        ])
      ),
      h('tr', [
        h('td', h('span.muted', 'Total')),
        ...report.channels.map((c) =>
          h('td.num', h('span.muted', showAmounts ? price(c.revenue_cents) : c.issued))
        ),
        h('td.num', h('strong', showAmounts ? price(report.totals.revenue_cents) : report.totals.issued)),
      ])
    );
  };
  paint();

  const toggle = h('div.row', { style: { gap: '6px' } }, [
    h('button.btn.small.quiet.solid', {
      'data-mode': 'count',
      onclick: () => {
        showAmounts = false;
        sync();
      },
    }, 'Cantidad'),
    h('button.btn.small.quiet', {
      'data-mode': 'amount',
      onclick: () => {
        showAmounts = true;
        sync();
      },
    }, 'Importe'),
  ]);

  function sync() {
    for (const b of toggle.querySelectorAll('[data-mode]')) {
      b.classList.toggle('solid', (b.dataset.mode === 'amount') === showAmounts);
    }
    paint();
  }

  const channelSegments = report.channels.map((c) => ({
    key: c.channel,
    label: c.label,
    value: c.issued,
    color: CHANNEL_COLOR[c.channel],
    ink: CHANNEL_INK[c.channel],
  }));

  return h('div.stack', { style: SECTION_GAP }, [
    h('div.spread', [
      h('div', [
        h('h2', 'Sector por canal'),
        h('span.faint', 'Dónde se vende cada parte de la sala'),
      ]),
      toggle,
    ]),

    rows.length
      ? h('div.card.stack', { style: { '--gap': '15px' } }, [
          h('p.faint', { style: { margin: 0 } },
            'Cada barra es un sector, al 100%. Si la mezcla de colores cambia de una ' +
            'fila a otra, ese sector se vende por un canal distinto que el resto.'),
          stackedRows(rows),
          legend(channelSegments),
        ])
      : null,

    h('div.card', { style: { padding: '6px 4px', overflowX: 'auto' } },
      h('table.simple', [
        h('thead', h('tr', [
          h('th', 'Sector'),
          ...report.channels.map((c) => h('th.num', c.label)),
          h('th.num', 'Total'),
        ])),
        body,
      ])
    ),
  ]);
}

const channelLabel = (report, key) =>
  report.channels.find((c) => c.channel === key)?.label || key;

// ─── Por categoría de precio ─────────────────────────────────────────────────

function tierSection(report) {
  if (!report.tiers.length) return null;
  return h('div.stack', { style: SECTION_GAP }, [
    h('div.spread', [
      h('h2', 'Por categoría de precio'),
      h('span.faint', 'El detalle fino, dentro de cada sector'),
    ]),
    h('div.card', { style: { padding: '6px 4px', overflowX: 'auto' } },
      h('table.simple', [
        h('thead', h('tr', [
          h('th', 'Categoría'),
          h('th.num', 'Emitidas'),
          h('th.num', 'Cortesías'),
          h('th.num', 'Recaudado'),
        ])),
        h('tbody', report.tiers.map((t) =>
          h('tr', [
            h('td', h('div.row', { style: { gap: '9px' } }, [
              h('i.dot', { style: { background: t.color } }),
              t.name,
            ])),
            h('td.num', t.issued),
            h('td.num', t.comp_count || h('span.faint', '—')),
            h('td.num', price(t.revenue_cents)),
          ])
        )),
      ])
    ),
  ]);
}

// ─── Emisión: boletería y cortesías ──────────────────────────────────────────

/**
 * Sin esta sección la columna "boletería física" del reporte nunca se llenaría.
 * Es la ventanilla del teatro: se elige categoría y cantidad, y el sistema
 * asigna las mejores butacas libres —que es lo que hace un boletero a mano—.
 * La butaca sale del mapa web en el acto.
 */
function issueSection(report, slug, reload) {
  const tierSelect = h('select',
    report.tiers.length
      ? report.tiers.map((t) => h('option', { value: t.tier_id }, t.name))
      : [h('option', { value: '' }, 'Sin categorías')]
  );
  const quantity = h('input', { type: 'number', min: '1', max: '50', value: '2' });
  const holder = h('input', { type: 'text', placeholder: 'Nombre de quien la retira' });
  const note = h('input', { type: 'text', placeholder: 'Motivo (prensa, invitado, canje…)' });
  const method = h('select', [
    h('option', { value: 'efectivo' }, 'Efectivo'),
    h('option', { value: 'debito' }, 'Débito'),
    h('option', { value: 'credito' }, 'Crédito'),
  ]);

  const noteField = h('label.field', { hidden: true }, [h('span', 'Motivo de la cortesía'), note]);
  const methodField = h('label.field', [h('span', 'Forma de pago'), method]);
  const result = h('div');

  let channel = 'boleteria';
  const tabs = h('div.row', { style: { gap: '6px' } }, [
    h('button.btn.small.quiet.solid', {
      type: 'button',
      'data-channel': 'boleteria',
      onclick: () => setChannel('boleteria'),
    }, 'Venta en boletería'),
    h('button.btn.small.quiet', {
      type: 'button',
      'data-channel': 'cortesia',
      onclick: () => setChannel('cortesia'),
    }, 'Cortesía'),
  ]);

  function setChannel(next) {
    channel = next;
    for (const b of tabs.querySelectorAll('[data-channel]')) {
      b.classList.toggle('solid', b.dataset.channel === next);
    }
    noteField.hidden = next !== 'cortesia';
    methodField.hidden = next !== 'boleteria';
    submit.textContent = next === 'cortesia' ? 'Emitir cortesía' : 'Vender y emitir';
  }

  const submit = h('button.btn', { type: 'submit' }, 'Vender y emitir');

  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      result.replaceChildren();
      try {
        const res = await api.issue(slug, {
          channel,
          tier_id: tierSelect.value,
          quantity: Number(quantity.value),
          holder_name: holder.value.trim() || undefined,
          note: channel === 'cortesia' ? note.value.trim() : undefined,
          payment_method: channel === 'boleteria' ? method.value : undefined,
        });
        result.replaceChildren(
          h('div.notice.good.stack', { style: { '--gap': '6px' } }, [
            h('strong',
              `${plural(res.count, 'entrada emitida', 'entradas emitidas')} · orden ${res.order_code}`),
            h('div',
              res.channel === 'cortesia'
                ? `Sin cargo. Valor de referencia: ${price(res.face_value_cents)}.`
                : `Cobrado: ${price(res.total_cents)}.`),
            res.tickets[0]?.seat
              ? h('div', res.tickets
                  .map((t) => `${t.seat.section} F${t.seat.row}·${t.seat.number}`)
                  .join('  ·  '))
              : null,
          ])
        );
        toast('Entradas emitidas');
        setTimeout(reload, 1200);
      } catch (err) {
        result.replaceChildren(h('div.notice.bad', err.message || 'No pudimos emitir'));
      }
      submit.disabled = false;
    },
  }, [
    tabs,
    h('div.row', { style: { gap: '12px', alignItems: 'flex-end' } }, [
      h('label.field.grow', [h('span', 'Categoría'), tierSelect]),
      h('label.field', { style: { width: '110px' } }, [h('span', 'Cantidad'), quantity]),
      methodField,
    ]),
    h('label.field', [h('span', 'A nombre de'), holder]),
    noteField,
    h('div.row', [submit]),
    result,
  ]);

  return h('div.stack', { style: SECTION_GAP }, [
    h('div.spread', [
      h('h2', 'Emitir entradas'),
      h('span.faint', 'Ventanilla del teatro e invitaciones'),
    ]),
    h('div.card.stack', [
      h('p.muted', { style: { margin: 0, fontSize: '0.92rem' } },
        'Lo que se emite acá usa el mismo inventario que la venta web: la butaca ' +
        'desaparece del mapa en el acto y la entrada aparece en el reporte con su canal. ' +
        'Si no elegís butacas, el sistema asigna las mejores libres de esa categoría.'),
      form,
    ]),
  ]);
}
