import { h } from './ui.js';

/**
 * Gráficos del reporte. Sin librerías: son barras apiladas al 100%, que es la
 * forma correcta para "parte de un todo" con nombres largos en español.
 *
 * Por qué barras apiladas y no tortas:
 *   - Comparar ángulos es más difícil que comparar longitudes, y acá el lector
 *     tiene que comparar entre sectores, no solo mirar uno.
 *   - Con una barra por sector se ve de un vistazo si la mezcla de canales
 *     cambia entre palcos y plateas. Con seis tortas, no.
 *
 * Reglas que sigue el dibujo:
 *   - 2 px de separación entre segmentos, contra el fondo, para que dos colores
 *     vecinos nunca se toquen (es lo que salva la lectura con daltonismo).
 *   - Extremos redondeados solo en las puntas de la barra.
 *   - El color nunca es la única señal: siempre hay leyenda, y los segmentos
 *     grandes llevan el porcentaje escrito adentro.
 *   - Debajo de cada gráfico hay una tabla con los mismos números.
 *
 * La paleta está en styles.css (`--ch-*` y `--ramp-*`) y se validó con el
 * verificador de contraste y daltonismo: separación mínima ΔE 9,2 en deuteranopía
 * y 27,6 en visión normal, en los dos temas.
 */

const pct = (value, total) => (total ? (value / total) * 100 : 0);

export const formatPct = (n, digits = 1) =>
  `${n.toFixed(digits).replace('.', ',')}%`;

/**
 * Barra apilada al 100 %.
 * @param segments [{ key, label, value, color, ink }] — `ink` es el color del
 *        número que va adentro del segmento, elegido para contrastar con su
 *        propio relleno (no con el fondo de la página).
 */
export function shareBar(segments, { total, height = 34, labelMin = 9 } = {}) {
  const sum = total ?? segments.reduce((a, s) => a + s.value, 0);
  const visible = segments.filter((s) => s.value > 0);

  const bar = h('div.share-bar', { style: { height: `${height}px` }, role: 'img' });

  if (!visible.length) {
    bar.append(h('div.share-empty', 'Sin entradas emitidas'));
    return bar;
  }

  bar.setAttribute(
    'aria-label',
    visible.map((s) => `${s.label}: ${formatPct(pct(s.value, sum))}`).join('; ')
  );

  for (const segment of visible) {
    const share = pct(segment.value, sum);
    const slice = h('div.share-slice', {
      style: { width: `${share}%`, background: segment.color, color: segment.ink || '#fff' },
      'data-tip': `${segment.label} · ${segment.value} · ${formatPct(share)}`,
      tabindex: '0',
    });
    // El número va adentro solo si entra: un porcentaje cortado a la mitad es
    // peor que no ponerlo. Los chicos quedan en la leyenda, con el mismo
    // redondeo que acá — el mismo dato nunca se muestra con dos valores.
    if (share >= labelMin) slice.append(h('span', formatPct(share)));
    bar.append(slice);
  }
  return bar;
}

/** Leyenda con cuadradito de color, nombre, cantidad y porcentaje. */
export function legend(segments, { total } = {}) {
  const sum = total ?? segments.reduce((a, s) => a + s.value, 0);
  return h('ul.chart-legend',
    segments.map((s) =>
      h('li', [
        h('i.swatch', { style: { background: s.color } }),
        h('span.name', s.label),
        h('span.value', `${s.value}`),
        h('span.share', formatPct(pct(s.value, sum))),
      ])
    )
  );
}

/**
 * Serie de barras apiladas, una por fila, todas al 100 %: sirve para comparar
 * la mezcla entre categorías (por ejemplo, el canal dentro de cada sector).
 */
export function stackedRows(rows, { height = 26 } = {}) {
  return h('div.stacked-rows',
    rows.map((row) => {
      const sum = row.segments.reduce((a, s) => a + s.value, 0);
      return h('div.stacked-row', [
        h('div.stacked-label', [
          h('span', row.label),
          h('span.faint', `${sum}`),
        ]),
        sum === 0
          ? h('div.share-bar', { style: { height: `${height}px` } },
              h('div.share-empty', 'Sin emitir'))
          : shareBar(row.segments, { height, labelMin: 14 }),
      ]);
    })
  );
}

/**
 * Un solo tooltip para toda la página: se posiciona sobre el elemento que tenga
 * `data-tip`. Se activa con el mouse y también con el teclado, porque los
 * segmentos son enfocables.
 */
export function attachTooltips(root) {
  const tip = h('div.chart-tip', { hidden: true });
  root.append(tip);

  const show = (target) => {
    const text = target.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    const box = target.getBoundingClientRect();
    const base = root.getBoundingClientRect();
    tip.style.left = `${box.left - base.left + box.width / 2}px`;
    tip.style.top = `${box.top - base.top}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };

  root.addEventListener('pointerover', (e) => {
    const target = e.target.closest('[data-tip]');
    if (target) show(target);
    else hide();
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focusin', (e) => {
    const target = e.target.closest('[data-tip]');
    if (target) show(target);
  });
  root.addEventListener('focusout', hide);
  return root;
}
