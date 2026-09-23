import { db } from '../db.js';
import { id, token, nowIso, inSeconds, forbidden } from './util.js';

/**
 * Autenticación de desarrollo: email + nombre, sin contraseña.
 *
 * En producción esto se reemplaza por un magic link o un código OTP al mail;
 * el resto de la app no cambia porque todo pasa por `req.user`.
 * Ver README → "Qué falta para producción".
 */

const SESSION_DAYS = 30;

export function findOrCreateUser({ email, name, role = 'fan' }) {
  const normalized = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
  if (existing) return existing;
  const user = {
    id: id('usr'),
    email: normalized,
    name: name?.trim() || normalized.split('@')[0],
    role,
    created_at: nowIso(),
  };
  db.prepare(
    'INSERT INTO users (id, email, name, role, created_at) VALUES (@id, @email, @name, @role, @created_at)'
  ).run(user);
  return user;
}

export function createSession(userId) {
  const t = token();
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(t, userId, nowIso(), inSeconds(SESSION_DAYS * 86400));
  return t;
}

/** Adjunta req.user si el header Authorization trae una sesión válida. */
export function attachUser(req, _res, next) {
  const header = req.get('authorization') || '';
  const t = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (t) {
    const row = db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`
      )
      .get(t, nowIso());
    if (row) req.user = row;
  }
  next();
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(forbidden('Iniciá sesión para continuar'));
  next();
}
