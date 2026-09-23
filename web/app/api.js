/**
 * Cliente de la API y estado compartido (sesión, cola, reserva en curso).
 *
 * Todo lo que tiene que sobrevivir a un refresco vive en localStorage: la
 * sesión, el token de cola y la reserva activa. Esa es la razón de fondo por
 * la que en Tres Tickets no se pierde el lugar al recargar la página.
 */

const BASE = (window.TT_API || '') + '/api';

const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`tres.${key}`);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(`tres.${key}`);
      else localStorage.setItem(`tres.${key}`, JSON.stringify(value));
    } catch {
      /* modo privado o almacenamiento lleno: seguimos sin persistir */
    }
  },
};

export const session = {
  get token() {
    return store.get('token');
  },
  get user() {
    return store.get('user');
  },
  save(token, user) {
    store.set('token', token);
    store.set('user', user);
    listeners.forEach((fn) => fn());
  },
  clear() {
    store.set('token', null);
    store.set('user', null);
    listeners.forEach((fn) => fn());
  },
};

const listeners = new Set();
export const onSessionChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Token de cola por evento: el lugar guardado del usuario. */
export const queueStore = {
  get: (slug) => store.get(`queue.${slug}`),
  set: (slug, value) => store.set(`queue.${slug}`, value),
  clear: (slug) => store.set(`queue.${slug}`, null),
};

/** Reserva activa por evento, para poder volver al checkout tras un refresco. */
export const holdStore = {
  get: (slug) => store.get(`hold.${slug}`),
  set: (slug, value) => store.set(`hold.${slug}`, value),
  clear: (slug) => store.set(`hold.${slug}`, null),
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || 'Error de red');
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'No hay conexión. Revisá tu internet.');
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) throw new ApiError(res.status, data?.error || 'error', data?.message);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),

  // Catálogo
  events: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return request('GET', `/events${qs.toString() ? `?${qs}` : ''}`);
  },
  event: (slug) => request('GET', `/events/${slug}`),
  seats: (slug) => request('GET', `/events/${slug}/seats`),

  // Cola
  joinQueue: (slug) => request('POST', `/events/${slug}/queue`, {}),
  queueStatus: (token) => request('GET', `/queue/${token}`),

  // Reserva y pago
  holdSeats: (slug, seatIds, queueToken) =>
    request('POST', `/events/${slug}/holds`, { seat_ids: seatIds, queue_token: queueToken }),
  holdGa: (slug, lines, queueToken) =>
    request('POST', `/events/${slug}/holds`, { lines, queue_token: queueToken }),
  hold: (id) => request('GET', `/holds/${id}`),
  releaseHold: (id) => request('DELETE', `/holds/${id}`),
  checkout: (holdId, payment) => request('POST', `/holds/${holdId}/checkout`, { payment }),
  order: (code) => request('GET', `/orders/${code}`),
  refund: (code) => request('POST', `/orders/${code}/refund`, {}),

  // Entradas
  wallet: () => request('GET', '/me/tickets'),
  transfer: (ticketId, email, name) =>
    request('POST', `/tickets/${ticketId}/transfer`, { email, name }),

  // Organizador
  organizerEvents: () => request('GET', '/organizer/events'),
  updateEvent: (slug, changes) => request('PATCH', `/organizer/events/${slug}`, changes),
  scan: (code) => request('POST', '/organizer/scan', { code }),
  report: (slug) => request('GET', `/organizer/events/${slug}/report`),
  issue: (slug, body) => request('POST', `/organizer/events/${slug}/issue`, body),

  /** El CSV necesita el token, así que lo bajamos con fetch y lo entregamos
   *  como archivo en vez de usar un enlace directo. */
  async downloadReport(slug) {
    const res = await fetch(`${BASE}/organizer/events/${slug}/report.csv`, {
      headers: session.token ? { Authorization: `Bearer ${session.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'download_failed', 'No pudimos generar el CSV');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ventas-${slug}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  login: (email, name) => request('POST', '/auth/login', { email, name }),
};
