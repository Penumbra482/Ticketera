# Tres Tickets

Ticketera para teatro, recitales y eventos independientes. Hace lo mismo que
las plataformas de siempre, pero resolviendo las cuatro cosas que más molestan
al comprar una entrada — y la que más molesta al venderlas: un reporte que
distingue de verdad entre palcos y plateas, entre boletería y web, y entre lo
vendido y lo regalado.

**No hay reventa entre usuarios, y es una decisión de producto, no una función
que falta.** Ver "Por qué no hay reventa", más abajo.

## Cómo se ejecuta

**Antes que nada hace falta Node.js 22.5 o más nuevo.** Es el único requisito, y
se instala una sola vez desde [nodejs.org](https://nodejs.org) (la versión LTS,
el botón grande). Para saber si ya lo tenés, escribí `node -v` en una terminal:
si responde algo como `v22.22.2`, estás.

Después, la forma más corta según tu sistema:

**Windows** — doble clic en **`iniciar.cmd`**. No hace falta abrir PowerShell ni
moverse de carpeta: el script se ubica solo, verifica Node, levanta el servidor y
te abre el navegador. Si Windows pregunta si confiás en el archivo, es porque
vino dentro de un zip descargado; dale *Más información → Ejecutar de todas
formas*.

**macOS y Linux** — doble clic en **`iniciar.sh`**, o desde la terminal:

```bash
./iniciar.sh          # la primera vez quizás haga falta: chmod +x iniciar.sh
```

**Desde cualquier terminal**, si preferís el camino manual:

```bash
cd tres-tickets
npm start
```

Y en cualquiera de los tres casos, la app queda en **http://localhost:4000**. La
primera vez que arranca, el servidor carga solo los tres eventos de ejemplo.

**No hace falta `npm install`**: el proyecto no tiene una sola dependencia de
runtime. De hecho tampoco hace falta npm — `node server/src/index.js` alcanza.

### Si algo no arranca

| Lo que dice | Qué pasa |
|---|---|
| `npm no se reconoce como...` | Node.js no está instalado, o se instaló pero no cerraste y volviste a abrir la terminal. Windows solo ve los programas nuevos en las ventanas que abrís **después** de instalarlos. |
| `npm.ps1 no se puede cargar` | PowerShell tiene la ejecución de scripts bloqueada por seguridad. No hay que tocar esa configuración: la restricción es **solo de PowerShell**, así que el mismo `npm start` funciona en **cmd.exe** (Símbolo del sistema). También sirven `iniciar.cmd` con doble clic, o `node server\src\index.js`, que no pasa por npm. |
| `Could not read package.json` | Estás parado en la carpeta equivocada. Al descomprimir suele quedar una carpeta adentro de otra (`tres-tickets/tres-tickets`); tenés que estar donde está el `package.json`. `iniciar.cmd` no tiene este problema. |
| `Tenés Node X, y hace falta 22.5` | La base usa el SQLite que viene adentro de Node, que en versiones anteriores no existe. Instalá la LTS encima. |
| `El puerto 4000 ya está ocupado` | Ya lo tenés corriendo en otra ventana: probá abrir http://localhost:4000. Si querés otro puerto, `PORT=4001 npm start`. |
| La página queda en blanco | Abriste `web/index.html` con doble clic. No alcanza: hay que levantar el servidor y entrar por `http://localhost:4000`. |
| `ERR_CONNECTION_REFUSED` / "no se puede acceder a este sitio" | No hay nadie escuchando en el 4000: el servidor no está corriendo. Lo más común es haber **cerrado la ventana de la terminal** donde estaba (se apaga con ella). Volvé a levantarlo. Si se cayó solo, mirá `server/data/errores.log`: ahí queda el detalle de lo que pasó. |

Otros comandos:

```bash
npm run dev      # igual que start, pero reinicia solo al editar un archivo
npm run seed     # recarga los datos de ejemplo (borra lo que haya)
npm run reset    # borra la base entera y la vuelve a crear
npm test         # los 23 tests
PORT=4001 npm start   # si el 4000 está ocupado
```

---

## Las cinco decisiones que definen el producto

### 1. El precio que ves es el que pagás

El cargo de servicio no aparece recién en el último paso. La API nunca devuelve
un precio "desnudo": cada categoría expone `total_cents` (valor + cargo) y ese
es el número que se muestra en la grilla, en el mapa de asientos, en la barra
de selección y en el checkout. El desglose está al lado, no escondido.

Un test lo verifica: el `from_cents` de la portada es el mínimo de los precios
**finales**, y el total del checkout es idéntico al que se vio al elegir.

→ `server/src/lib/pricing.js`

### 2. La cola respeta el orden de llegada y no se pierde al refrescar

La posición es un entero que se asigna al entrar y nunca se recalcula. El token
vive en el navegador (`localStorage`), así que cerrar la pestaña, refrescar o
cambiar de red no manda al final de la fila. El servidor admite como máximo
`queue_capacity` compradores en simultáneo y va dejando entrar al siguiente
cuando alguien termina o se le vence el turno.

El tiempo estimado se calcula con el ritmo real de admisiones de los últimos
cinco minutos, no con un número inventado.

→ `server/src/services/queue.js`, `web/app/pages/queue.js`

### 3. Elegir el asiento se hace mirando la sala

Mapa en SVG con zoom (rueda, pellizco y botones), arrastre, y precio final al
tocar cada butaca. El filtro por categoría **atenúa** en vez de esconder, para
no perder la referencia espacial. Un toque se distingue de un arrastre por
umbral de movimiento: no se seleccionan lugares sin querer al mover el mapa
con el dedo.

Cuando tocás una butaca queda reservada 10 minutos y desaparece del mapa de los
demás en el acto. Nunca pasa lo de elegir un asiento y enterarse al pagar de que
ya no está.

→ `web/app/pages/seatmap.js`, `server/src/services/inventory.js`

### 4. Si no podés ir, se resuelve solo — y sin precio de por medio

Dos caminos, los dos desde la billetera y sin llamar a nadie:

- **Transferirla**: gratis. La entrada pasa a nombre de otra persona y el código
  anterior queda anulado en el acto.
- **Devolverla**: completa hasta el día del evento. La ubicación vuelve al mapa
  al valor original, para quien la quiera.

El secreto del QR rota en cada transferencia, así que una captura de pantalla
vieja deja de servir sola. En la puerta, cada código entra una única vez.

#### Por qué no hay reventa

La versión anterior tenía reventa entre fans con tope de precio. Se sacó.

Un tope suena bien en el papel y se rompe en la práctica: cuando la demanda
aprieta, el sobreprecio se muda al efectivo, a la transferencia bancaria por
fuera y a los mercados paralelos, y la plataforma termina prestando su nombre
para dar apariencia de legitimidad a un precio que no controla. Antes que
vigilar un mercado interno, la decisión acá es no tenerlo: la única forma de que
una entrada cambie de manos es la transferencia (sin plata de por medio) o la
devolución (a valor original, y vuelve al público).

Es un intercambio explícito, no gratis: quien no puede ir y quería recuperar su
dinero de otro fan ahora depende de la devolución, y el evento se queda sin un
mecanismo formal para reasignar entradas de última hora. Si algún día hiciera
falta cubrir ese caso, el camino que no reintroduce el problema es una lista de
espera oficial: la entrada se devuelve al organizador al valor original y él la
reasigna al primero de la lista. Nunca un mercado entre particulares.

→ `server/src/services/transfers.js`, `web/app/pages/wallet.js`

### 5. El reporte de ventas dice quién compró qué, y por dónde

El reporte de una ticketera tradicional es una sola línea: *vendiste 812
entradas y recaudaste tanto*. Con eso no se decide nada. Las preguntas reales
del que produce un evento son otras, y acá cada entrada emitida se clasifica por
dos ejes independientes que las contestan:

- **Sector** (`price_tiers.kind`): palcos, plateas, pullman, campo, populares,
  mesas, entrada general. Es el **tipo de ubicación**, no el nombre comercial:
  "Platea baja" y "Platea alta" son dos categorías de precio pero un solo
  sector, y por eso se pueden comparar dos eventos o dos salas distintas.
- **Canal** (`tickets.channel`): compra virtual, boletería física y cortesías.

Y el cruce de los dos, que es donde aparece lo que no se ve de otra forma —por
ejemplo, que los palcos se vendan casi solo en la ventanilla, porque quien los
compra prefiere hablar con una persona—.

Dos reglas que hacen que el número sea confiable:

1. **Las cortesías nunca suman a lo recaudado**, pero se informa siempre cuántas
   son y cuánto habrían valido. Regalar cien entradas es una decisión legítima;
   no verla en ningún lado, no.
2. **Lo emitido cierra con el mapa.** Cada butaca ocupada en el mapa es una
   entrada del reporte, con su sector y su canal. No hay dos fuentes de verdad.

La boletería no es un campo declarativo: el organizador emite ahí mismo, desde
el reporte, y la butaca desaparece del mapa web en el acto. Sin eso la columna
"boletería física" sería decorativa.

Cada eje se muestra **dos veces a propósito**: como gráfico, para ver la
proporción de un vistazo, y como tabla, para leer el número exacto y para que
funcione con lector de pantalla. Los gráficos son barras apiladas al 100 % —no
tortas—: comparar longitudes es más fácil que comparar ángulos, y el cruce
sector × canal se dibuja como una barra por sector, todas al 100 %, así se ve de
un vistazo si un sector se vende por un canal distinto que el resto.

La paleta se validó con un verificador de daltonismo y contraste en los dos
temas (separación mínima ΔE 9,2 en deuteranopía, 27,6 en visión normal); el
color nunca es la única señal: hay leyenda, porcentaje escrito dentro de los
segmentos grandes y tabla equivalente debajo de cada gráfico.

Todo el reporte se baja en CSV (separador `;` y coma decimal, que es lo que
Excel en español abre sin pelear).

→ `server/src/services/reports.js`, `server/src/services/boxoffice.js`,
`web/app/charts.js`, `web/app/pages/report.js`

---

## Cómo probarlo

Después de `npm run seed` quedan tres eventos, uno de cada tipo:

| Evento | Tipo | Para ver |
|---|---|---|
| **La casa de los espejos** | Teatro, butacas numeradas | Mapa de sala, tres sectores: platea, pullman y palcos |
| **Nube Roja — Gira 2026** | Recital, butacas numeradas | Cola virtual encendida (25 compradores en simultáneo) |
| **Noche de stand up en el Sótano** | Independiente, entrada general | Selección por cantidad, sin mapa |

Los tres vienen con ventas ya cargadas, repartidas entre compra virtual,
boletería física y cortesías, para que el reporte tenga algo real que mostrar
desde el primer minuto.

Y tres cuentas de prueba (se entra solo con el email, sin contraseña):

- `fan@trestickets.test` — comprador
- `productora@trestickets.test` — organizador: panel, reporte de ventas, boletería
  y control de acceso

Un recorrido que muestra todo en cinco minutos:

1. Entrá a **Nube Roja** → sumate a la cola → mirá la posición y el tiempo
   estimado → refrescá la página para comprobar que no perdés el lugar.
2. Cuando te toque, elegí dos butacas y mirá el reloj de la reserva en el
   checkout.
3. Pagá (la tarjeta viene cargada, no se cobra nada) y andá a **Mis entradas**:
   ahí está el QR.
4. Probá los dos caminos de salida: pasásela a otra persona por email, o pedí
   la devolución y mirá cómo la butaca vuelve al mapa.
5. Entrá como `productora@trestickets.test` → **Organizador** → pegá el contenido del
   QR en el control de acceso. Validalo dos veces: la segunda dice que ya
   ingresó.
6. En el mismo panel, **Reporte de ventas**: mirá cómo se separan palcos,
   plateas y pullman en los gráficos, y cómo se reparte entre web, boletería y
   cortesías. Abajo, emití dos entradas por boletería y una cortesía, y mirá
   cómo se mueven las barras y cómo desaparecen del mapa público.

---

## Arquitectura

```
tres-tickets/
├── server/                  API + servidor de archivos estáticos
│   ├── src/
│   │   ├── index.js         arranque, rutas, tareas periódicas
│   │   ├── schema.sql       esquema completo, comentado
│   │   ├── seed.js          datos de ejemplo
│   │   ├── db.js            SQLite (node:sqlite) + transacciones anidables
│   │   ├── lib/
│   │   │   ├── http.js      micro-framework tipo Express, sin dependencias
│   │   │   ├── auth.js      sesiones por token
│   │   │   ├── pricing.js   precio final en un solo lugar
│   │   │   └── util.js      ids, errores HTTP, fechas
│   │   ├── services/        reglas de negocio (lo importante vive acá)
│   │   │   ├── queue.js     cola virtual
│   │   │   ├── inventory.js reservas de butacas y de entrada general
│   │   │   ├── orders.js    pago, emisión y devolución
│   │   │   ├── transfers.js pasarle la entrada a otra persona
│   │   │   ├── boxoffice.js venta en ventanilla y cortesías
│   │   │   └── reports.js   ventas por sector y por canal
│   │   └── routes/          HTTP: valida, llama al servicio, responde
│   └── test/
│       ├── flow.test.js     recorrido completo contra la API real
│       ├── qr.test.js       el QR, verificado con OpenCV
│       └── decode_qr.py     decodificador independiente (solo para tests)
└── web/                     frontend, sin build y sin framework
    ├── index.html
    └── app/
        ├── main.js          router y cáscara
        ├── api.js           cliente + estado persistente
        ├── ui.js            h(), formatos, modal, toast
        ├── styles.css
        ├── charts.js        barras apiladas del reporte
        ├── lib/qr.js        generador de QR propio
        └── pages/           una por pantalla (incluye report.js)
```

**Por qué sin dependencias.** El backend usa `node:sqlite` y `node:http`; el
frontend son módulos ES que el navegador carga tal cual. Se clona y corre: no
hay `npm install` que pueda romperse, ni build que mantener, ni versiones que
migrar. Para un proyecto de este tamaño el costo de escribir un router de 200
líneas es menor que el de arrastrar un árbol de dependencias.

**Dónde está la lógica.** Todo el negocio está en `services/`; las rutas solo
validan y responden. Eso hace que las reglas (quién puede revender, cuándo se
libera una butaca, cómo avanza la cola) se lean en un solo lugar y se puedan
testear sin HTTP.

**Dinero en enteros.** Todos los importes se guardan en centavos. Nunca floats.

---

## El generador de QR

`web/app/lib/qr.js` implementa la norma ISO/IEC 18004 (modo byte, versiones 1 a
40, los cuatro niveles de corrección). El servidor manda solo el texto firmado y
el navegador dibuja el código: la entrada aparece al instante y **sigue
funcionando sin señal**, que es justo el momento en que hace falta.

Como está escrito a mano, hay una contraprueba que no comparte su código: las
matrices se le pasan a OpenCV y se exige que las decodifique de vuelta al texto
exacto (`server/test/qr.test.js`). Ese test encontró dos errores reales durante
el desarrollo — un módulo del patrón de sincronismo pisado por la reserva de la
información de formato, y el paso entre patrones de alineación mal calculado, que
rompía de la versión 7 en adelante.

La verificación cubre hoy las versiones 1 a 18, que es de sobra para el uso real:
el código de una entrada ocupa unos 56 caracteres, o sea versión 4. Las tablas de
las versiones más altas están escritas pero todavía no se validaron contra un
lector real; `server/test/discover_tables.mjs` es la herramienta que las deriva
usando OpenCV como oráculo, y termina de correrlas cuando haga falta.

---

## Tests

```bash
npm test
```

- **`flow.test.js`** levanta la API con una base temporal y recorre el camino
  completo: precio final en la grilla → cola FIFO → mapa → reserva → conflicto
  de butacas → pago → billetera → transferencia con QR viejo anulado →
  devolución → control de acceso → panel del organizador.
- Dentro del mismo archivo, el bloque del **reporte de ventas** comprueba lo que
  tiene que cerrar sí o sí: que los sectores sumen el total, que las columnas y
  las filas del cruce sector × canal cierren entre ellas, que una venta por
  boletería descuente del mapa público, que una cortesía sume ubicación pero no
  recaudación, y que el reporte de un evento no lo pueda ver otra productora.
  Dos pruebas más cuidan la decisión de no tener reventa: que los endpoints
  viejos devuelvan 404, y que los dos caminos de salida (transferir y devolver)
  sigan funcionando.
- **`qr.test.js`** verifica el generador de QR contra OpenCV. Si en la máquina no
  hay OpenCV (`python3 -c "import cv2"`), esas pruebas se saltean solas y las
  estructurales igual corren.

---

## API

Todas las rutas cuelgan de `/api`. Las marcadas con 🔒 piden
`Authorization: Bearer <token>`.

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/auth/login` | Entra con email y devuelve `{ token, user }` |
| `GET` | `/events` | Lista con filtros `q`, `category`, `city` |
| `GET` | `/events/:slug` | Ficha, precios finales y disponibilidad |
| `GET` | `/events/:slug/seats` | Mapa completo de butacas |
| `POST` | `/events/:slug/queue` | Entra a la cola |
| `GET` | `/queue/:token` | Posición, personas adelante y tiempo estimado |
| `POST` | `/events/:slug/holds` | Reserva butacas (`seat_ids`) o generales (`lines`) |
| `DELETE` | `/holds/:id` | Suelta la reserva |
| `POST` | `/holds/:id/checkout` | 🔒 Paga y emite las entradas |
| `GET` | `/orders/:code` | Detalle de la compra |
| `POST` | `/orders/:code/refund` | 🔒 Devolución completa |
| `GET` | `/me/tickets` | 🔒 Billetera, con el contenido del QR |
| `POST` | `/tickets/:id/transfer` | 🔒 Se la pasa a otra persona |
| `GET` | `/organizer/events` | 🔒 Panel de ventas y cola |
| `PATCH` | `/organizer/events/:id` | 🔒 Ajusta la cola y el máximo por compra |
| `POST` | `/organizer/scan` | 🔒 Valida un QR en la puerta |
| `GET` | `/organizer/events/:id/report` | 🔒 Ventas por sector, por canal y el cruce |
| `GET` | `/organizer/events/:id/report.csv` | 🔒 El mismo reporte para planilla |
| `POST` | `/organizer/events/:id/issue` | 🔒 Emite por boletería o como cortesía |

Variables de entorno: `PORT` (4000), `TT_DB`, `TT_DATA_DIR`,
`TT_HOLD_SECONDS` (600), `TT_QR_SECRET`.

---

## Qué falta para producción

Esto es una base funcional y honesta, no un sistema listo para vender entradas
mañana. Lo que hay que resolver antes, en orden de importancia:

1. **Pagos de verdad.** El checkout simula el cobro. Hay que integrar un
   procesador (Mercado Pago, Stripe) con webhooks: la entrada se emite recién
   cuando el pago está confirmado, y la reserva se sostiene mientras el pago
   está pendiente.
2. **Autenticación real.** Hoy se entra solo con el email. Reemplazarlo por un
   enlace mágico o un código al correo; el resto de la app no cambia porque todo
   pasa por `req.user`.
3. **Postgres y varios procesos.** SQLite en un solo proceso aguanta bien una
   sala de teatro, pero no una venta de estadio. La migración es acotada porque
   el SQL está todo en `db.js` y `services/`. La cola y el barrido de reservas
   vencidas tienen que pasar a un worker aparte, y las reservas necesitan
   `SELECT ... FOR UPDATE`.
4. **Límite de pedidos por IP y detección de bots** en la cola: sin eso, la cola
   más justa del mundo se llena de scripts.
5. **Correo transaccional**: confirmación de compra, aviso de transferencia y
   comprobante de devolución.
6. **Lector de QR con cámara** para el personal de puerta, y modo sin conexión
   con la lista de códigos válidos descargada de antemano.
7. **Accesibilidad del mapa**: hoy el SVG se maneja con mouse y dedo. Falta
   recorrerlo con teclado y una vista alternativa en lista para lectores de
   pantalla.
8. **Auditoría**: registro inmutable de cada cambio de titular de una entrada.
