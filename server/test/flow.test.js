import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Recorrido completo contra la API real, con base de datos temporal:
 * cola virtual → mapa de asientos → reserva → pago → billetera →
 * transferencia → devolución → reporte de ventas → control de acceso.
 *
 * Correlo con `npm test` desde /server.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}/api`;

let server;
let tmpDir;

async function api(method, url, { body, token } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const login = async (email, name) =>
  (await api('POST', '/auth/login', { body: { email, name } })).body;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tres-tickets-test-'));
  const env = { ...process.env, TT_DATA_DIR: tmpDir, PORT: String(PORT) };

  await new Promise((resolve, reject) => {
    const seed = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/seed.js'], {
      cwd: ROOT,
      env,
      stdio: 'ignore',
    });
    seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('seed falló'))));
  });

  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  });

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* todavía no levantó */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el servidor no arrancó');
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('la grilla muestra el precio final, con el cargo de servicio adentro', async () => {
  const { body } = await api('GET', '/events');
  assert.equal(body.events.length, 3);

  const detail = (await api('GET', '/events/la-casa-de-los-espejos')).body;
  const platea = detail.tiers.find((t) => t.name === 'Platea');
  assert.equal(platea.total_cents, platea.face_cents + platea.fee_cents);
  // "Desde" también es el precio final, no el facial.
  const cheapest = Math.min(...detail.tiers.map((t) => t.total_cents));
  assert.equal(detail.event.from_cents, cheapest);
});

test('la cola es FIFO y no se pierde el lugar al refrescar', async () => {
  const first = (await api('POST', '/events/nube-roja-gira-2026/queue')).body;
  const second = (await api('POST', '/events/nube-roja-gira-2026/queue')).body;

  assert.ok(second.position > first.position, 'la posición avanza en orden de llegada');

  // Consultar el estado dos veces no cambia la posición: refrescar es seguro.
  const again = (await api('GET', `/queue/${first.token}`)).body;
  assert.equal(again.position, first.position);
  assert.equal(again.status, 'admitted'); // capacidad 25, entra directo
  assert.ok(again.seconds_left > 0, 'el admitido tiene reloj visible');
});

test('sin token de cola no se puede reservar en un evento con cola', async () => {
  const seats = (await api('GET', '/events/nube-roja-gira-2026/seats')).body;
  const free = seats.seats.find((s) => !s.taken);
  const res = await api('POST', '/events/nube-roja-gira-2026/holds', {
    body: { seat_ids: [free.id] },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'queue_required');
});

test('flujo completo: cola → butacas → pago → billetera', async () => {
  const ana = await login('ana@test.com', 'Ana Gómez');
  const queue = (await api('POST', '/events/nube-roja-gira-2026/queue')).body;
  assert.equal(queue.status, 'admitted');

  const seats = (await api('GET', '/events/nube-roja-gira-2026/seats')).body;
  const free = seats.seats.filter((s) => !s.taken).slice(0, 2);
  assert.equal(free.length, 2);

  const hold = (
    await api('POST', '/events/nube-roja-gira-2026/holds', {
      token: ana.token,
      body: { seat_ids: free.map((s) => s.id), queue_token: queue.token },
    })
  ).body;
  assert.equal(hold.hold.items.length, 2);
  assert.ok(hold.hold.seconds_left > 0, 'la reserva tiene reloj');
  assert.equal(
    hold.hold.total_cents,
    hold.hold.subtotal_cents + hold.hold.fees_cents,
    'el total del checkout es el mismo precio final que se vio en el mapa'
  );

  // Las butacas desaparecen del mapa de los demás en el acto.
  const after = (await api('GET', '/events/nube-roja-gira-2026/seats')).body;
  for (const s of free) {
    assert.equal(after.seats.find((x) => x.id === s.id).taken, true);
  }

  // Y nadie más puede tomarlas.
  const q2 = (await api('POST', '/events/nube-roja-gira-2026/queue')).body;
  const clash = await api('POST', '/events/nube-roja-gira-2026/holds', {
    body: { seat_ids: [free[0].id], queue_token: q2.token },
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'seats_taken');

  const paid = await api('POST', `/holds/${hold.hold.id}/checkout`, {
    token: ana.token,
    body: { payment: { brand: 'visa', last4: '4242' } },
  });
  assert.equal(paid.status, 201);
  assert.match(paid.body.code, /^TT-[2-9A-Z]{6}$/);
  assert.equal(paid.body.ticket_ids.length, 2);

  // El token de cola se consume al pagar y libera el lugar para el siguiente.
  const spent = (await api('GET', `/queue/${queue.token}`)).body;
  assert.equal(spent.status, 'used');

  const wallet = (await api('GET', '/me/tickets', { token: ana.token })).body;
  assert.equal(wallet.tickets.length, 2);
  assert.ok(wallet.tickets[0].qr_code.startsWith('tres://t/'), 'el QR viene con la billetera');
  assert.ok(wallet.tickets[0].seat.row, 'la entrada dice fila y butaca');
});

test('la reserva vencida devuelve las butacas al mapa', async () => {
  const seats = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  const free = seats.seats.filter((s) => !s.taken).slice(0, 3);
  const hold = (
    await api('POST', '/events/la-casa-de-los-espejos/holds', {
      body: { seat_ids: free.map((s) => s.id) },
    })
  ).body;

  const held = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  assert.equal(held.seats.find((s) => s.id === free[0].id).taken, true);

  await api('DELETE', `/holds/${hold.hold.id}`);

  const released = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  for (const s of free) {
    assert.equal(released.seats.find((x) => x.id === s.id).taken, false);
  }
});

test('entrada general: no se puede reservar más de lo que hay', async () => {
  const detail = (await api('GET', '/events/noche-de-stand-up-sotano')).body;
  const general = detail.availability.find((t) => t.name === 'General');

  const tooMany = await api('POST', '/events/noche-de-stand-up-sotano/holds', {
    body: { lines: [{ tier_id: general.tier_id, quantity: 99 }] },
  });
  assert.equal(tooMany.status, 400); // supera el máximo por compra

  const ok = (
    await api('POST', '/events/noche-de-stand-up-sotano/holds', {
      body: { lines: [{ tier_id: general.tier_id, quantity: 3 }] },
    })
  ).body;
  assert.equal(ok.hold.items[0].quantity, 3);

  const after = (await api('GET', '/events/noche-de-stand-up-sotano')).body;
  const generalAfter = after.availability.find((t) => t.name === 'General');
  assert.equal(generalAfter.available, general.available - 3);
});

test('transferir a un amigo cambia el titular y rota el código', async () => {
  const dario = await login('dario@test.com', 'Darío Paz');
  const seats = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  const free = seats.seats.filter((s) => !s.taken)[0];
  const hold = (
    await api('POST', '/events/la-casa-de-los-espejos/holds', {
      token: dario.token,
      body: { seat_ids: [free.id] },
    })
  ).body;
  const order = (
    await api('POST', `/holds/${hold.hold.id}/checkout`, { token: dario.token, body: {} })
  ).body;
  const ticketId = order.ticket_ids[0];

  const before = (await api('GET', '/me/tickets', { token: dario.token })).body.tickets.find(
    (t) => t.id === ticketId
  );

  const res = await api('POST', `/tickets/${ticketId}/transfer`, {
    token: dario.token,
    body: { email: 'elena@test.com', name: 'Elena Sosa' },
  });
  assert.equal(res.status, 200);

  const elena = await login('elena@test.com', 'Elena Sosa');
  const hers = (await api('GET', '/me/tickets', { token: elena.token })).body.tickets.find(
    (t) => t.id === ticketId
  );
  assert.ok(hers, 'la recibió');
  assert.equal(hers.holder_name, 'Elena Sosa');
  assert.notEqual(hers.qr_code, before.qr_code, 'el código anterior queda inservible');
});

test('devolución: libera la butaca y la vuelve a poner a la venta', async () => {
  const fede = await login('fede@test.com', 'Fede Luna');
  const seats = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  const free = seats.seats.filter((s) => !s.taken)[0];
  const hold = (
    await api('POST', '/events/la-casa-de-los-espejos/holds', {
      token: fede.token,
      body: { seat_ids: [free.id] },
    })
  ).body;
  const order = (
    await api('POST', `/holds/${hold.hold.id}/checkout`, { token: fede.token, body: {} })
  ).body;

  const refund = await api('POST', `/orders/${order.code}/refund`, { token: fede.token, body: {} });
  assert.equal(refund.status, 200);

  const after = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  assert.equal(after.seats.find((s) => s.id === free.id).taken, false);
});

test('el panel del organizador refleja las ventas y la cola', async () => {
  const productora = await login('productora@trestickets.test', 'Productora Sur');
  const { body } = await api('GET', '/organizer/events', { token: productora.token });
  assert.equal(body.events.length, 3);
  const recital = body.events.find((e) => e.slug === 'nube-roja-gira-2026');
  assert.ok(recital.sold_count > 0);
  assert.ok(recital.capacity > recital.available);
  assert.ok(typeof recital.queue.waiting === 'number');
});

// ─── Reporte de ventas discriminado ──────────────────────────────────────────

test('el reporte separa por sector: palcos, plateas y pullman por separado', async () => {
  const productora = await login('productora@trestickets.test', 'Productora Sur');
  const { body } = await api('GET', '/organizer/events/la-casa-de-los-espejos/report', {
    token: productora.token,
  });

  const sectors = Object.fromEntries(body.sectors.map((s) => [s.sector, s]));
  assert.ok(sectors.palco, 'los palcos son una fila propia');
  assert.ok(sectors.platea, 'las plateas son una fila propia');
  assert.ok(sectors.pullman, 'el pullman no se mezcla con la platea');

  // Cada sector informa su capacidad y su ocupación por separado: ese es el
  // punto — "vendí 100 entradas" no dice si los palcos se están moviendo.
  for (const s of body.sectors) {
    assert.ok(s.capacity > 0);
    assert.equal(s.available, s.capacity - occupiedOf(s));
    assert.ok(s.sell_through >= 0 && s.sell_through <= 1);
  }

  // Los sectores suman el total.
  assert.equal(
    body.sectors.reduce((a, s) => a + s.issued, 0),
    body.totals.issued
  );

  function occupiedOf(sector) {
    // `issued` cuenta entradas en circulación, que es exactamente lo que ocupa
    // una ubicación en este evento (no hay reservas activas durante el test).
    return sector.issued;
  }
});

test('el reporte separa por canal: web, boletería y cortesías', async () => {
  const productora = await login('productora@trestickets.test', 'Productora Sur');
  const { body } = await api('GET', '/organizer/events/la-casa-de-los-espejos/report', {
    token: productora.token,
  });

  const channels = body.channels.map((c) => c.channel);
  assert.deepEqual(channels, ['web', 'boleteria', 'cortesia']);

  const byChannel = Object.fromEntries(body.channels.map((c) => [c.channel, c]));
  assert.ok(byChannel.web.issued > 0, 'hay ventas por internet');
  assert.ok(byChannel.boleteria.issued > 0, 'hay ventas por boletería');
  assert.ok(byChannel.cortesia.issued > 0, 'hay cortesías');

  // Las cortesías nunca suman a lo recaudado, pero sí informan cuánto valían.
  assert.equal(byChannel.cortesia.revenue_cents, 0);
  assert.ok(body.totals.comp_value_cents > 0, 'se informa el valor regalado');
  assert.equal(body.totals.comp_count, byChannel.cortesia.issued);

  assert.equal(
    body.channels.reduce((a, c) => a + c.issued, 0),
    body.totals.issued
  );
});

test('el cruce sector × canal cierra por filas y por columnas', async () => {
  const productora = await login('productora@trestickets.test', 'Productora Sur');
  const { body } = await api('GET', '/organizer/events/la-casa-de-los-espejos/report', {
    token: productora.token,
  });

  for (const row of body.matrix) {
    const sector = body.sectors.find((s) => s.sector === row.sector);
    assert.equal(row.cells.reduce((a, c) => a + c.count, 0), row.total.count);
    assert.equal(row.total.count, sector.issued, `la fila ${row.label} cierra`);
  }

  for (const [i, channel] of body.channels.entries()) {
    const column = body.matrix.reduce((a, row) => a + row.cells[i].count, 0);
    assert.equal(column, channel.issued, `la columna ${channel.label} cierra`);
  }
});

test('venta por boletería: descuenta del mapa y aparece en su canal', async () => {
  const productora = await login('productora@trestickets.test', 'Productora Sur');
  const before = (
    await api('GET', '/organizer/events/la-casa-de-los-espejos/report', { token: productora.token })
  ).body;
  const palcos = before.sectors.find((s) => s.sector === 'palco');
  const tier = before.tiers.find((t) => t.sector === 'palco');
  const boleteriaBefore = before.channels.find((c) => c.channel === 'boleteria').issued;

  const sold = await api('POST', '/organizer/events/la-casa-de-los-espejos/issue', {
    token: productora.token,
    body: {
      channel: 'boleteria',
      tier_id: tier.tier_id,
      quantity: 2,
      holder_name: 'Marta Ríos',
      payment_method: 'efectivo',
    },
  });
  assert.equal(sold.status, 201);
  assert.equal(sold.body.count, 2);
  assert.ok(sold.body.tickets[0].seat, 'la boletería asigna butacas concretas');

  const after = (
    await api('GET', '/organizer/events/la-casa-de-los-espejos/report', { token: productora.token })
  ).body;
  const palcosAfter = after.sectors.find((s) => s.sector === 'palco');

  assert.equal(palcosAfter.issued, palcos.issued + 2);
  assert.equal(palcosAfter.available, palcos.available - 2, 'salieron del inventario');
  assert.equal(
    after.channels.find((c) => c.channel === 'boleteria').issued,
    boleteriaBefore + 2
  );
  assert.ok(
    after.totals.revenue_cents > before.totals.revenue_cents,
    'la venta en boletería suma a lo recaudado'
  );

  // Y desaparecieron del mapa que ve el público.
  const seats = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  for (const t of sold.body.tickets) {
    const seat = seats.seats.find(
      (s) => s.section === t.seat.section && s.row === t.seat.row && s.number === t.seat.number
    );
    assert.equal(seat.taken, true);
  }
});

test('cortesía: se emite sin cargo, exige motivo y no ensucia lo recaudado', async () => {
  const productora = await login('productora@trestickets.test', 'Productora Sur');
  const before = (
    await api('GET', '/organizer/events/la-casa-de-los-espejos/report', { token: productora.token })
  ).body;
  const tier = before.tiers.find((t) => t.sector === 'platea');

  const sinMotivo = await api('POST', '/organizer/events/la-casa-de-los-espejos/issue', {
    token: productora.token,
    body: { channel: 'cortesia', tier_id: tier.tier_id, quantity: 1 },
  });
  assert.equal(sinMotivo.status, 400, 'toda cortesía tiene que decir por qué se regaló');

  const comp = await api('POST', '/organizer/events/la-casa-de-los-espejos/issue', {
    token: productora.token,
    body: {
      channel: 'cortesia',
      tier_id: tier.tier_id,
      quantity: 3,
      holder_name: 'Diario del Centro',
      note: 'Prensa — nota previa',
    },
  });
  assert.equal(comp.status, 201);
  assert.equal(comp.body.total_cents, 0, 'no se cobra');
  assert.ok(comp.body.face_value_cents > 0, 'pero se sabe cuánto valía');

  const after = (
    await api('GET', '/organizer/events/la-casa-de-los-espejos/report', { token: productora.token })
  ).body;

  assert.equal(after.totals.comp_count, before.totals.comp_count + 3);
  assert.equal(after.totals.revenue_cents, before.totals.revenue_cents, 'no mueve lo recaudado');
  assert.equal(
    after.totals.comp_value_cents,
    before.totals.comp_value_cents + comp.body.face_value_cents,
    'sí mueve el valor regalado'
  );
  assert.equal(after.totals.issued, before.totals.issued + 3, 'pero sí ocupan lugares');
});

test('el CSV trae las tres tablas del reporte', async () => {
  const productora = await login('productora@trestickets.test', 'Productora Sur');
  const res = await fetch(`${BASE}/organizer/events/la-casa-de-los-espejos/report.csv`, {
    headers: { Authorization: `Bearer ${productora.token}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /ventas-la-casa-de-los-espejos\.csv/);

  const csv = await res.text();
  for (const heading of ['RESUMEN', 'POR SECTOR', 'POR CANAL', 'SECTOR POR CANAL', 'POR CATEGORÍA DE PRECIO']) {
    assert.ok(csv.includes(heading), `falta la sección ${heading}`);
  }
  assert.ok(csv.includes('Palcos;'), 'los palcos son una fila del CSV');
  assert.ok(!csv.includes('Reventa'), 'la reventa ya no existe en el producto');
  assert.ok(csv.includes('Boletería física;'), 'la boletería es una fila del CSV');
});

test('el reporte es privado: solo lo ve el organizador del evento', async () => {
  const ajena = await login('ajena@test.com', 'Productora Ajena');
  const res = await api('GET', '/organizer/events/la-casa-de-los-espejos/report', {
    token: ajena.token,
  });
  assert.equal(res.status, 403);

  const sinSesion = await api('GET', '/organizer/events/la-casa-de-los-espejos/report');
  assert.equal(sinSesion.status, 403);

  const emitir = await api('POST', '/organizer/events/la-casa-de-los-espejos/issue', {
    token: ajena.token,
    body: { channel: 'boleteria', tier_id: 'x', quantity: 1 },
  });
  assert.equal(emitir.status, 403);
});

test('la reventa no existe: los endpoints viejos devuelven 404', async () => {
  // La reventa entre usuarios se sacó del producto a propósito. Un tope de
  // precio no aguanta cuando la demanda aprieta, así que en vez de vigilar un
  // mercado interno directamente no lo hay: quien no puede ir transfiere la
  // entrada o pide la devolución, y la ubicación vuelve al mapa al valor
  // original. Este test existe para que nadie la reintroduzca sin querer.
  const ana = await login('reventa@test.com', 'Ana Prueba');
  const seats = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  const free = seats.seats.filter((s) => !s.taken)[0];
  const hold = (
    await api('POST', '/events/la-casa-de-los-espejos/holds', {
      token: ana.token,
      body: { seat_ids: [free.id] },
    })
  ).body;
  const order = (
    await api('POST', `/holds/${hold.hold.id}/checkout`, { token: ana.token, body: {} })
  ).body;
  const ticketId = order.ticket_ids[0];

  for (const [method, path] of [
    ['POST', `/tickets/${ticketId}/list`],
    ['GET', `/tickets/${ticketId}/resale-cap`],
    ['GET', '/events/la-casa-de-los-espejos/listings'],
    ['POST', '/listings/lst_x/buy'],
    ['DELETE', '/listings/lst_x'],
  ]) {
    const res = await api(method, path, {
      token: ana.token,
      body: method === 'GET' ? undefined : { price_cents: 100 },
    });
    assert.equal(res.status, 404, `${method} ${path} ya no debería existir`);
  }

  // La ficha del evento tampoco expone nada de reventa.
  const detail = (await api('GET', '/events/la-casa-de-los-espejos')).body;
  assert.equal(detail.resale, undefined);
  assert.equal(detail.event.resale_enabled, undefined);
  assert.equal(detail.event.resale_cap_pct, undefined);

  // Y la billetera muestra la entrada sin ninguna acción de venta.
  const wallet = (await api('GET', '/me/tickets', { token: ana.token })).body;
  const mine = wallet.tickets.find((t) => t.id === ticketId);
  assert.ok(mine);
  assert.equal(mine.listing, undefined);
  assert.equal(mine.resale_max_cents, undefined);
});

test('el camino de salida sigue existiendo: transferir o devolver', async () => {
  // Sacar la reventa solo es defendible si quien no puede ir tiene qué hacer.
  const dueno = await login('duenio@test.com', 'Sofía Cruz');
  const seats = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  const free = seats.seats.filter((s) => !s.taken).slice(0, 2);

  const hold = (
    await api('POST', '/events/la-casa-de-los-espejos/holds', {
      token: dueno.token,
      body: { seat_ids: free.map((s) => s.id) },
    })
  ).body;
  const order = (
    await api('POST', `/holds/${hold.hold.id}/checkout`, { token: dueno.token, body: {} })
  ).body;

  // 1. Se la paso a alguien, gratis.
  const transfer = await api('POST', `/tickets/${order.ticket_ids[0]}/transfer`, {
    token: dueno.token,
    body: { email: 'amiga@test.com', name: 'Lucía Ferrer' },
  });
  assert.equal(transfer.status, 200);

  // 2. O la devuelvo, y la butaca vuelve al mapa al valor original.
  const refund = await api('POST', `/orders/${order.code}/refund`, {
    token: dueno.token,
    body: {},
  });
  assert.equal(refund.status, 200);

  const after = (await api('GET', '/events/la-casa-de-los-espejos/seats')).body;
  assert.equal(
    after.seats.find((s) => s.id === free[1].id).taken,
    false,
    'la ubicación devuelta vuelve a estar a la venta'
  );
});

// ─── El servidor no se cae ───────────────────────────────────────────────────

test('ninguna petición mala tumba el servidor', async () => {
  // Regresión de un bug real: el manejador de peticiones era `async`, así que
  // cualquier excepción que se escapara se volvía una promesa rechazada sin
  // atrapar y Node terminaba el proceso. Para quien estaba usando la app eso
  // era "no se puede acceder a este sitio", sin más explicación.
  const raro = [
    ['GET', '/events/100%descuento'],        // % suelto: rompe decodeURIComponent
    ['GET', '/events/%E0%A4%A'],             // secuencia UTF-8 incompleta
    ['GET', '/queue/%%%'],
    ['GET', '/orders/%ZZ'],
    ['GET', '/holds/%2e%2e%2f%2e%2e'],
    ['GET', '/events/' + 'a'.repeat(3000)],  // ruta larguísima
    ['POST', '/auth/login'],
    ['DELETE', '/listings/%'],
  ];

  for (const [method, path] of raro) {
    const res = await api(method, path);
    assert.ok(res.status >= 400 && res.status < 600, `${method} ${path} responde algo`);
  }

  // Lo único que importa de verdad: después de todo eso, sigue vivo.
  const health = await fetch(`${BASE}/health`);
  assert.equal(health.status, 200, 'el servidor sobrevivió');

  // Y sigue sirviendo de verdad, no solo respondiendo el health.
  const { body } = await api('GET', '/events');
  assert.equal(body.events.length, 3);
});

test('un cuerpo JSON roto o gigante no rompe nada', async () => {
  const roto = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ esto no es json',
  });
  assert.equal(roto.status, 400);

  const gigante = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.com', name: 'x'.repeat(400_000) }),
  });
  assert.equal(gigante.status, 413, 'se rechaza por tamaño, no se traga 400 KB');

  const health = await fetch(`${BASE}/health`);
  assert.equal(health.status, 200, 'el servidor sobrevivió');
});

test('cancelar pedidos a mitad de camino no tumba el servidor', async () => {
  // Reproduce lo que hace un navegador cuando alguien cambia de pantalla
  // mientras la página todavía está pidiendo datos: corta la conexión. El
  // servidor se quedaba escribiendo en un socket muerto y se moría.
  for (let i = 0; i < 25; i++) {
    const control = new AbortController();
    const pedido = fetch(`${BASE}/events/la-casa-de-los-espejos/seats`, {
      signal: control.signal,
    }).catch(() => {});
    // Cortar en distintos momentos: algunos antes de que llegue la respuesta,
    // otros justo mientras se está escribiendo.
    setTimeout(() => control.abort(), i % 5);
    await pedido;
  }

  // Y unas cuantas conexiones crudas cortadas de golpe, sin cerrar bien.
  await Promise.all(
    Array.from({ length: 10 }, () => {
      const control = new AbortController();
      const p = fetch(`${BASE}/organizer/events`, { signal: control.signal }).catch(() => {});
      control.abort();
      return p;
    })
  );

  await new Promise((r) => setTimeout(r, 300));

  const health = await fetch(`${BASE}/health`);
  assert.equal(health.status, 200, 'el servidor sobrevivió a las desconexiones');

  const { body } = await api('GET', '/events');
  assert.equal(body.events.length, 3, 'y sigue respondiendo bien');
});
