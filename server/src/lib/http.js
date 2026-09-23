import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

/**
 * Micro-framework HTTP sobre `node:http`.
 *
 * Tres Tickets no tiene dependencias de runtime: se clona y se corre con `node`, sin
 * `npm install`, sin compilar nada. Esto cubre lo que usamos de Express
 * (routers montables, params en la ruta, body JSON, middlewares, manejo de
 * errores y archivos estáticos) en unas pocas decenas de líneas. Si el día de
 * mañana hace falta algo más, la superficie es la misma de Express y se puede
 * cambiar el import sin tocar las rutas.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * `decodeURIComponent` tira una excepción con cualquier `%` suelto en la URL
 * (`/api/events/100%descuento`, un enlace mal copiado, un escáner de seguridad).
 * Un servidor no se puede caer por eso: si no se puede decodificar, devolvemos
 * el texto tal cual y que la ruta decida que no existe.
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Compila '/events/:slug/seats' a una expresión regular con nombres. */
function compile(pattern) {
  if (pattern instanceof RegExp) return { regex: pattern, keys: [] };
  const keys = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (!part) return '';
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '/([^/]+)';
      }
      return '/' + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return { regex: new RegExp(`^${source || '/'}/?$`), keys };
}

export function Router() {
  const layers = [];
  const router = {
    layers,
    use(pathOrFn, maybeFn) {
      const prefix = typeof pathOrFn === 'string' ? pathOrFn : '';
      const handler = typeof pathOrFn === 'string' ? maybeFn : pathOrFn;
      layers.push({ type: 'use', prefix, handler });
      return router;
    },
  };
  for (const method of METHODS) {
    router[method] = (pattern, ...handlers) => {
      const { regex, keys } = compile(pattern);
      layers.push({ type: 'route', method: method.toUpperCase(), regex, keys, handlers });
      return router;
    };
  }
  return router;
}

/** Recorre las capas de un router (y sus sub-routers) en orden. */
function runLayers(layers, req, res, basePath, done) {
  let i = 0;
  const next = (err) => {
    if (err) return done(err);
    const layer = layers[i++];
    if (!layer) return done();

    if (layer.type === 'use') {
      if (layer.prefix && !basePath.startsWith(layer.prefix)) return next();
      const rest = layer.prefix ? basePath.slice(layer.prefix.length) || '/' : basePath;
      if (layer.handler?.layers) return runLayers(layer.handler.layers, req, res, rest, next);
      return callHandler(layer.handler, req, res, next);
    }

    if (layer.method !== req.method) return next();
    const match = layer.regex.exec(basePath);
    if (!match) return next();

    req.params = {};
    layer.keys.forEach((k, idx) => {
      req.params[k] = safeDecode(match[idx + 1]);
    });

    let h = 0;
    const nextHandler = (err2) => {
      if (err2) return done(err2);
      const handler = layer.handlers[h++];
      if (!handler) return next();
      callHandler(handler, req, res, nextHandler);
    };
    nextHandler();
  };
  next();
}

function callHandler(handler, req, res, next) {
  try {
    const out = handler(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createApp({ staticDir = null, spaFallback = false } = {}) {
  const root = Router();
  const errorHandlers = [];

  function decorate(req, res) {
    /**
     * Lo primero de todo: escuchar los errores del socket.
     *
     * Cuando alguien cambia de página mientras un pedido está en curso —cosa
     * que pasa todo el tiempo al navegar rápido— el navegador corta la conexión.
     * El servidor, que todavía estaba trabajando, termina escribiendo en un
     * socket muerto. Ese error se emite en el objeto de respuesta y, si nadie
     * lo escucha, Node termina el proceso entero.
     *
     * Es decir: la persona cambiaba de pantalla en el momento justo y el
     * servidor se moría. Con estos dos manejadores, se pierde ese pedido y nada
     * más.
     */
    req.on('error', (err) => {
      if (err?.code !== 'ECONNRESET') console.error('  Conexión con error:', err?.message);
    });
    res.on('error', (err) => {
      if (err?.code !== 'ECONNRESET') console.error('  Respuesta con error:', err?.message);
    });

    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    req.get = (name) => req.headers[String(name).toLowerCase()];

    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.set = (name, value) => {
      res.setHeader(name, value);
      return res;
    };
    res.type = (t) => {
      res.setHeader('Content-Type', MIME[`.${t}`] || t);
      return res;
    };
    res.json = (body) => {
      const payload = JSON.stringify(body);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(payload);
      return res;
    };
    res.send = (body) => {
      res.end(body);
      return res;
    };
    res.sendFile = (file) => {
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      const stream = fs.createReadStream(file);
      // Sin este manejador, un error de lectura (permisos, disco, el archivo
      // borrado entre el chequeo y la lectura) emite un 'error' sin escuchar y
      // Node termina el proceso: el servidor se cae entero por un archivo.
      stream.on('error', (err) => {
        console.error(`  No se pudo leer ${file}: ${err.message}`);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
      stream.pipe(res);
      return res;
    };
  }

  function readBody(req) {
    const MAX_BODY = 256 * 1024;

    return new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
      const chunks = [];
      let size = 0;
      let overflowed = false;

      req.on('data', (c) => {
        if (overflowed) return;
        size += c.length;
        if (size > MAX_BODY) {
          overflowed = true;
          // Descartamos el resto en vez de destruir la conexión: si la matamos
          // acá, el cliente ve "error de red" y nunca llega a leer el 413 que
          // le explica que mandó demasiado.
          req.removeAllListeners('data');
          req.resume();
          reject(new HttpError(413, 'too_large', 'Cuerpo demasiado grande'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new HttpError(400, 'bad_json', 'JSON inválido'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res) {
    if (!staticDir) return false;
    const rel = safeDecode(req.path).replace(/^\/+/, '');
    const target = path.join(staticDir, rel || 'index.html');
    if (!target.startsWith(staticDir)) return false; // path traversal
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      res.sendFile(target);
      return true;
    }
    if (spaFallback && !req.path.startsWith('/api')) {
      const index = path.join(staticDir, 'index.html');
      if (fs.existsSync(index)) {
        res.sendFile(index);
        return true;
      }
    }
    return false;
  }

  /**
   * Todo el manejo de una petición va adentro de un try/catch.
   *
   * Esto no es paranoia: el manejador es `async`, así que cualquier excepción
   * que se escape se convierte en una promesa rechazada que nadie atrapa, y
   * Node —de la versión 15 en adelante— termina el proceso. Es decir: una sola
   * petición rara tiraba abajo el servidor entero y el usuario se quedaba con
   * "no se puede acceder a este sitio" sin ninguna explicación.
   */
  const server = http.createServer(async (req, res) => {
    try {
      decorate(req, res);

      // CORS abierto: la API es pública y el frontend puede vivir en otro origen.
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') return res.status(204).end();

      req.body = await readBody(req);

      runLayers(root.layers, req, res, req.path, (err) => {
        try {
          if (err) return finish(err, req, res);
          if (serveStatic(req, res)) return;
          res.status(404).json({ error: 'not_found', message: 'Ruta inexistente' });
        } catch (inner) {
          finish(inner, req, res);
        }
      });
    } catch (err) {
      finish(err, req, res);
    }
  });

  // Peticiones HTTP mal formadas a nivel protocolo (no de ruta): Node las avisa
  // acá y, sin manejador, puede terminar el proceso.
  server.on('clientError', (err, socket) => {
    if (!socket.destroyed && socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    void err;
  });

  function finish(err, req, res) {
    // Si la conexión ya se cortó del otro lado, no hay a quién responderle.
    // Ojo: se mira SOLO la respuesta. `req.destroyed` también se pone en true
    // cuando el cuerpo de un POST terminó de leerse con normalidad, así que
    // usarlo acá dejaba peticiones válidas sin contestar nunca.
    if (res.destroyed) return;

    // Si la respuesta ya salió, escribir de nuevo tira otra excepción encima de
    // la primera. Se registra y se corta acá.
    if (res.headersSent || res.writableEnded) {
      console.error('  Error después de responder:', err?.stack || err);
      try {
        res.end();
      } catch {
        /* la conexión ya está cerrada */
      }
      return;
    }

    for (const handler of errorHandlers) {
      try {
        return handler(err, req, res, () => {});
      } catch (e) {
        err = e;
      }
    }

    try {
      res.status(500).json({ error: 'internal', message: 'Algo salió mal' });
    } catch (e) {
      console.error('  No se pudo responder el error:', e?.message);
      try {
        res.destroy();
      } catch {
        /* nada más que hacer */
      }
    }
  }

  return {
    use(...args) {
      const last = args[args.length - 1];
      if (typeof last === 'function' && last.length === 4) {
        errorHandlers.push(last);
        return this;
      }
      root.use(...args);
      return this;
    },
    ...Object.fromEntries(
      METHODS.map((m) => [m, (...args) => (root[m](...args), undefined)])
    ),
    server,
    listen: (port, cb) => server.listen(port, cb),
  };
}
