/**
 * Utilidades mínimas de vista: un creador de elementos, formateadores y
 * dos o tres piezas de interfaz. Sin framework, sin build: el navegador
 * carga estos módulos tal como están.
 */

/** h('div.card', { onclick }, [hijos]) → HTMLElement */
export function h(spec, props = null, children = []) {
  const [tagAndId, ...classes] = String(spec).split('.');
  const [tag, id] = tagAndId.split('#');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');

  // El segundo argumento puede ser el objeto de propiedades o directamente los
  // hijos. Cualquier cosa que no sea un objeto plano (texto, número, nodo,
  // lista) se toma como hijo.
  if (props !== null && (Array.isArray(props) || props instanceof Node || typeof props !== 'object')) {
    children = props;
    props = null;
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = `${el.className} ${value}`.trim();
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }

  append(el, children);
  return el;
}

export function append(el, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const clear = (el) => {
  el.replaceChildren();
  return el;
};

// ─── Formato ─────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

export const price = (cents) => money.format((cents || 0) / 100);

const dateLong = new Intl.DateTimeFormat('es-AR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});
const dateShort = new Intl.DateTimeFormat('es-AR', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export const whenLong = (iso) => capitalize(dateLong.format(new Date(iso)));
export const whenShort = (iso) => dateShort.format(new Date(iso));
export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "3 min 20 s" — pensado para relojes de cuenta regresiva. */
export function countdown(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  if (m >= 60) {
    const hours = Math.floor(m / 60);
    return `${hours} h ${m % 60} min`;
  }
  if (m === 0) return `${s} s`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const CATEGORY_LABELS = {
  musica: 'Música',
  teatro: 'Teatro',
  independiente: 'Independiente',
  deporte: 'Deporte',
};
export const categoryLabel = (slug) => CATEGORY_LABELS[slug] || capitalize(slug);

// ─── Piezas de interfaz ──────────────────────────────────────────────────────

export function toast(message, tone = '') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = h('div.toast-host');
    document.body.append(host);
  }
  const node = h('div.toast', { class: tone }, message);
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, 3600);
}

/** Modal simple. `render(close)` devuelve el contenido. */
export function modal(render) {
  const host = h('div.modal-host', {
    onclick: (e) => {
      if (e.target === host) close();
    },
  });
  const close = () => {
    host.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  host.append(h('div.modal', { role: 'dialog', 'aria-modal': 'true' }, render(close)));
  document.body.append(host);
  host.querySelector('input, button')?.focus();
  return close;
}

export const skeleton = (height = 120) =>
  h('div.skeleton', { style: { height: `${height}px` } });

export function empty(title, detail) {
  return h('div.card.stack', { style: { textAlign: 'center', padding: '38px 20px' } }, [
    h('h3', title),
    detail && h('p.muted', detail),
  ]);
}

/** Etiqueta de color de una categoría de precio. */
export const tierDot = (color) => h('i.dot', { style: { background: color } });
