import crypto from 'node:crypto';

export const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const token = () => crypto.randomBytes(24).toString('base64url');

/** Secreto del QR: corto a propósito. 96 bits siguen siendo imposibles de
 *  adivinar, y un payload corto entra en un QR de menos módulos, que se escanea
 *  más rápido con la cámara de un celular en una puerta con poca luz. */
export const qrSecret = () => crypto.randomBytes(12).toString('base64url');

/** Código de orden legible por teléfono: TT-7F3K2Q (sin caracteres ambiguos) */
export function orderCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return `TT-${out}`;
}

export const nowIso = () => new Date().toISOString();
export const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString();
export const isPast = (iso) => !!iso && new Date(iso).getTime() <= Date.now();

/** Error de dominio con status HTTP. Lo atrapa el middleware de errores. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (msg, code = 'bad_request') => new HttpError(400, code, msg);
export const notFound = (msg = 'No encontrado') => new HttpError(404, 'not_found', msg);
export const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);
export const forbidden = (msg = 'No autorizado') => new HttpError(403, 'forbidden', msg);

/** Envuelve un handler async para que los rechazos lleguen al middleware de errores. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
