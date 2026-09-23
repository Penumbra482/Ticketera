import { h, price } from '../ui.js';

/**
 * Mapa de asientos interactivo, en SVG.
 *
 * Lo que hace que sirva de verdad en un celular:
 *  - Zoom con rueda, con pellizco y con botones; arrastre con un dedo.
 *  - El toque en una butaca se distingue del arrastre por umbral de movimiento,
 *    así no se seleccionan lugares sin querer al mover el mapa.
 *  - Cada butaca muestra su precio final al tocarla, sin abrir otra pantalla.
 *  - Filtro por categoría de precio: atenúa lo que no entra en el presupuesto
 *    en vez de esconderlo, para no perder la referencia espacial de la sala.
 */

const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

export function seatMap({ data, tiers, maxSelection, onChange }) {
  const tierById = new Map(tiers.map((t) => [t.id, t]));
  const selected = new Map();
  let visibleTiers = new Set(tiers.map((t) => t.id));

  const { width, height, stage } = data.map;
  const view = { x: 0, y: 0, w: width, h: height };

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'application',
    'aria-label': 'Mapa de asientos',
  });

  // Escenario
  if (stage && stage.w) {
    svg.append(
      el('rect', {
        x: stage.x, y: stage.y, width: stage.w, height: stage.h,
        rx: 8, fill: 'currentColor', opacity: 0.12,
      })
    );
    const label = el('text', {
      x: stage.x + stage.w / 2, y: stage.y + stage.h / 2 + 5,
      'text-anchor': 'middle', 'font-size': 20, 'letter-spacing': 6,
      fill: 'currentColor', opacity: 0.55,
    });
    label.textContent = stage.label || 'ESCENARIO';
    svg.append(label);
  }

  // Etiquetas de sección
  const bySection = new Map();
  for (const seat of data.seats) {
    if (!bySection.has(seat.section)) bySection.set(seat.section, []);
    bySection.get(seat.section).push(seat);
  }
  for (const [name, seats] of bySection) {
    const minY = Math.min(...seats.map((s) => s.y));
    const midX = seats.reduce((a, s) => a + s.x, 0) / seats.length;
    const text = el('text', {
      x: midX, y: minY - 18,
      'text-anchor': 'middle', 'font-size': 15, fill: 'currentColor', opacity: 0.45,
    });
    text.textContent = name;
    svg.append(text);
  }

  // Butacas
  const seatsLayer = el('g');
  svg.append(seatsLayer);
  const nodes = new Map();

  for (const seat of data.seats) {
    const tier = tierById.get(seat.tier_id);
    const circle = el('circle', {
      cx: seat.x, cy: seat.y, r: 10,
      class: `seat${seat.taken ? ' taken' : ''}`,
      'data-id': seat.id,
    });
    paint(circle, seat, tier, false, true);
    seatsLayer.append(circle);
    nodes.set(seat.id, { circle, seat, tier });
  }

  function paint(circle, seat, tier, isSelected, visible) {
    if (seat.taken) {
      circle.setAttribute('fill', 'currentColor');
      circle.setAttribute('fill-opacity', '0.1');
      circle.setAttribute('stroke', 'none');
      return;
    }
    circle.setAttribute('fill', tier.color);
    circle.setAttribute('fill-opacity', visible ? (isSelected ? '1' : '0.82') : '0.12');
    circle.setAttribute('stroke', isSelected ? 'currentColor' : 'none');
    circle.setAttribute('stroke-width', isSelected ? '4' : '0');
  }

  // ─── Tooltip ───────────────────────────────────────────────────────────────
  const tooltip = h('div.seat-tooltip', { hidden: true });

  function showTooltip(seat, tier, clientX, clientY) {
    const rect = shell.getBoundingClientRect();
    tooltip.replaceChildren(
      h('div', `${seat.section} · Fila ${seat.row} · Butaca ${seat.number}`),
      h('div', { style: { opacity: 0.75 } },
        seat.taken ? 'Ocupada' : `${tier.name} — ${price(tier.total_cents)} final`),
      seat.note === 'accesible' ? h('div', { style: { opacity: 0.75 } }, 'Acceso sin escalones') : null
    );
    tooltip.hidden = false;
    tooltip.style.left = `${clientX - rect.left}px`;
    tooltip.style.top = `${clientY - rect.top}px`;
  }

  const hideTooltip = () => {
    tooltip.hidden = true;
  };

  // ─── Selección ─────────────────────────────────────────────────────────────

  function toggle(seatId) {
    const entry = nodes.get(seatId);
    if (!entry || entry.seat.taken) return;
    if (!visibleTiers.has(entry.seat.tier_id)) return;

    if (selected.has(seatId)) {
      selected.delete(seatId);
    } else {
      if (selected.size >= maxSelection) {
        onChange([...selected.values()], `Podés elegir hasta ${maxSelection} butacas por compra`);
        return;
      }
      selected.set(seatId, { ...entry.seat, tier: entry.tier });
    }
    repaint();
    onChange([...selected.values()]);
  }

  function repaint() {
    for (const { circle, seat, tier } of nodes.values()) {
      paint(circle, seat, tier, selected.has(seat.id), visibleTiers.has(seat.tier_id));
    }
  }

  // ─── Zoom y desplazamiento ─────────────────────────────────────────────────

  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function zoomAt(factor, clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;

    const newW = clamp(view.w / factor, width / 8, width);
    const newH = newW * (height / width);
    view.x = clamp(view.x + (view.w - newW) * px, -width * 0.1, width - newW + width * 0.1);
    view.y = clamp(view.y + (view.h - newH) * py, -height * 0.1, height - newH + height * 0.1);
    view.w = newW;
    view.h = newH;
    applyView();
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
  }, { passive: false });

  const pointers = new Map();
  let dragged = 0;
  let pinchStart = null;

  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), w: view.w };
    }
    shell.classList.add('dragging');
  });

  svg.addEventListener('pointermove', (e) => {
    const target = e.target.closest?.('.seat');
    if (target && pointers.size === 0) {
      const entry = nodes.get(target.dataset.id);
      if (entry) showTooltip(entry.seat, entry.tier, e.clientX, e.clientY);
    } else if (!target) {
      hideTooltip();
    }

    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = svg.getBoundingClientRect();
      const factor = dist / (pinchStart.dist || 1);
      const targetW = clamp(pinchStart.w / factor, width / 8, width);
      zoomAt(view.w / targetW, rect.left + rect.width / 2, rect.top + rect.height / 2);
      return;
    }

    const rect = svg.getBoundingClientRect();
    const dx = ((e.clientX - prev.x) / rect.width) * view.w;
    const dy = ((e.clientY - prev.y) / rect.height) * view.h;
    dragged += Math.abs(dx) + Math.abs(dy);
    view.x = clamp(view.x - dx, -width * 0.15, width - view.w + width * 0.15);
    view.y = clamp(view.y - dy, -height * 0.15, height - view.h + height * 0.15);
    applyView();
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) shell.classList.remove('dragging');
    // Umbral: si el dedo casi no se movió, fue un toque y no un arrastre.
    if (dragged < 6) {
      const target = e.target.closest?.('.seat');
      if (target) toggle(target.dataset.id);
    }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));
  svg.addEventListener('pointerleave', hideTooltip);

  const shell = h('div.seatmap-shell', [
    svg,
    tooltip,
    h('div.zoom-controls', [
      h('button', { type: 'button', 'aria-label': 'Acercar', onclick: () => zoomCenter(1.35) }, '+'),
      h('button', { type: 'button', 'aria-label': 'Alejar', onclick: () => zoomCenter(1 / 1.35) }, '−'),
      h('button', { type: 'button', 'aria-label': 'Ver toda la sala', onclick: reset, style: { fontSize: '0.8rem' } }, 'Todo'),
    ]),
  ]);

  function zoomCenter(factor) {
    const rect = svg.getBoundingClientRect();
    zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function reset() {
    view.x = 0;
    view.y = 0;
    view.w = width;
    view.h = height;
    applyView();
  }

  // ─── Filtro por categoría ──────────────────────────────────────────────────

  const legend = h('div.legend',
    tiers.map((tier) => {
      const button = h('button.item', {
        type: 'button',
        style: { background: 'none', border: 0, cursor: 'pointer', padding: '2px 0' },
        'aria-pressed': 'true',
        onclick: () => {
          if (visibleTiers.has(tier.id)) visibleTiers.delete(tier.id);
          else visibleTiers.add(tier.id);
          if (visibleTiers.size === 0) visibleTiers = new Set(tiers.map((t) => t.id));
          for (const b of legend.querySelectorAll('[data-tier]')) {
            b.setAttribute('aria-pressed', String(visibleTiers.has(b.dataset.tier)));
            b.style.opacity = visibleTiers.has(b.dataset.tier) ? '1' : '0.4';
          }
          repaint();
        },
      }, [
        h('i.dot', { style: { background: tier.color } }),
        h('span', `${tier.name} · ${price(tier.total_cents)}`),
      ]);
      button.dataset.tier = tier.id;
      return button;
    }).concat([
      h('span.item', [
        h('i.dot', { style: { background: 'currentColor', opacity: 0.18 } }),
        h('span', 'Ocupada'),
      ]),
    ])
  );

  return {
    node: h('div.stack', { style: { '--gap': '12px' } }, [shell, legend]),
    /** Marca butacas como ocupadas sin recargar todo (llega por refresco). */
    markTaken(ids) {
      for (const id of ids) {
        const entry = nodes.get(id);
        if (!entry || entry.seat.taken) continue;
        entry.seat.taken = true;
        selected.delete(id);
        entry.circle.classList.add('taken');
      }
      repaint();
    },
    clearSelection() {
      selected.clear();
      repaint();
    },
    get selection() {
      return [...selected.values()];
    },
  };
}
