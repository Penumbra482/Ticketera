-- Tres Tickets — esquema de base de datos
-- Todos los importes se guardan en centavos (enteros). Nunca floats para dinero.
-- Todas las fechas se guardan en ISO 8601 UTC (TEXT).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'fan',      -- fan | organizer
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venues (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  address     TEXT,
  capacity    INTEGER NOT NULL DEFAULT 0,
  -- Ancho/alto del lienzo del mapa de asientos (coordenadas SVG)
  map_width   INTEGER NOT NULL DEFAULT 1000,
  map_height  INTEGER NOT NULL DEFAULT 700,
  -- Forma del escenario en coordenadas del mapa: {"x":..,"y":..,"w":..,"h":..,"label":".."}
  stage_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  artist          TEXT NOT NULL,
  category        TEXT NOT NULL,              -- musica | teatro | independiente | deporte
  description     TEXT NOT NULL DEFAULT '',
  cover_color     TEXT NOT NULL DEFAULT '#5b5bd6',
  venue_id        TEXT NOT NULL REFERENCES venues(id),
  organizer_id    TEXT REFERENCES users(id),
  starts_at       TEXT NOT NULL,
  doors_at        TEXT,
  status          TEXT NOT NULL DEFAULT 'on_sale',   -- draft | on_sale | sold_out | past
  seating_type    TEXT NOT NULL DEFAULT 'reserved',  -- reserved | ga
  max_per_order   INTEGER NOT NULL DEFAULT 6,
  -- Cola virtual
  queue_enabled   INTEGER NOT NULL DEFAULT 0,
  queue_capacity  INTEGER NOT NULL DEFAULT 50,       -- compradores admitidos en simultáneo
  admit_ttl_secs  INTEGER NOT NULL DEFAULT 600,      -- tiempo para comprar una vez admitido
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);

-- Categorías de precio. El cargo de servicio se guarda aparte pero SIEMPRE
-- se muestra sumado: el usuario ve el precio final desde el primer momento.
CREATE TABLE IF NOT EXISTS price_tiers (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- Tipo de sector, para poder reportar por separado palcos, plateas, campo,
  -- populares, mesas y entrada general. El nombre comercial ("Platea baja")
  -- cambia por evento; el tipo es lo que permite comparar entre eventos.
  kind        TEXT NOT NULL DEFAULT 'general',
  color       TEXT NOT NULL DEFAULT '#5b5bd6',
  price_cents INTEGER NOT NULL,
  fee_cents   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tiers_event ON price_tiers(event_id);

-- Butacas numeradas (seating_type = 'reserved')
CREATE TABLE IF NOT EXISTS seats (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tier_id     TEXT NOT NULL REFERENCES price_tiers(id),
  section     TEXT NOT NULL,
  row_label   TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  -- Nota de accesibilidad / visibilidad: 'ok' | 'vision_parcial' | 'accesible'
  note        TEXT NOT NULL DEFAULT 'ok',
  status      TEXT NOT NULL DEFAULT 'available',  -- available | held | sold
  hold_id     TEXT,
  UNIQUE (event_id, section, row_label, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_seats_event_status ON seats(event_id, status);

-- Inventario de entrada general (seating_type = 'ga')
CREATE TABLE IF NOT EXISTS ga_inventory (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tier_id     TEXT NOT NULL REFERENCES price_tiers(id),
  quantity    INTEGER NOT NULL,
  held        INTEGER NOT NULL DEFAULT 0,
  sold        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ga_event ON ga_inventory(event_id);

-- Cola virtual: FIFO estricto por posición. El token vive en el navegador,
-- así que refrescar la página NO hace perder el lugar.
CREATE TABLE IF NOT EXISTS queue_tokens (
  token       TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'waiting',   -- waiting | admitted | used | expired
  joined_at   TEXT NOT NULL,
  admitted_at TEXT,
  expires_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_event_pos ON queue_tokens(event_id, status, position);

-- Reserva temporal mientras el usuario completa la compra
CREATE TABLE IF NOT EXISTS holds (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  queue_token  TEXT,
  user_id      TEXT REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'active',   -- active | converted | expired | released
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_holds_expiry ON holds(status, expires_at);

CREATE TABLE IF NOT EXISTS hold_items (
  id        TEXT PRIMARY KEY,
  hold_id   TEXT NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
  seat_id   TEXT REFERENCES seats(id),
  tier_id   TEXT NOT NULL REFERENCES price_tiers(id),
  quantity  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_hold_items_hold ON hold_items(hold_id);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,          -- código corto legible: TT-7F3K2Q
  event_id       TEXT NOT NULL REFERENCES events(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  kind           TEXT NOT NULL DEFAULT 'primary', -- primary (no hay reventa: ver services/transfers.js)
  -- Canal de emisión, la otra mitad del reporte de ventas:
  --   web       compra por la plataforma
  --   boleteria venta presencial en la boletería del teatro
  --   cortesia  entrada regalada (prensa, invitados, canje) — importe 0
  channel        TEXT NOT NULL DEFAULT 'web',
  operator_id    TEXT REFERENCES users(id),      -- quién la emitió en boletería
  note           TEXT,                            -- motivo de la cortesía, observaciones
  subtotal_cents INTEGER NOT NULL,
  fees_cents     INTEGER NOT NULL,
  total_cents    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'paid',   -- paid | refunded
  payment_brand  TEXT,
  payment_last4  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);

CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  event_id      TEXT NOT NULL REFERENCES events(id),
  owner_id      TEXT NOT NULL REFERENCES users(id),
  seat_id       TEXT REFERENCES seats(id),
  tier_id       TEXT NOT NULL REFERENCES price_tiers(id),
  face_cents    INTEGER NOT NULL,               -- valor facial pagado (sin cargo de servicio)
  fee_cents     INTEGER NOT NULL DEFAULT 0,
  holder_name   TEXT NOT NULL,
  -- Copiado de la orden a propósito: el reporte por canal tiene que poder
  -- leerse de una sola tabla, y el canal de una entrada ya emitida no cambia
  -- aunque después se transfiera.
  channel       TEXT NOT NULL DEFAULT 'web',
  -- El secreto rota en cada transferencia: el QR viejo deja de servir al instante
  qr_secret     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'valid',  -- valid | checked_in | refunded
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_report ON tickets(event_id, channel, status);

CREATE TABLE IF NOT EXISTS transfers (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES tickets(id),
  from_id     TEXT NOT NULL REFERENCES users(id),
  to_email    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'completed',
  created_at  TEXT NOT NULL
);
