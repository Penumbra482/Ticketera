import { h, clear, append, toast, modal } from './ui.js';
import { api, session, onSessionChange, ApiError } from './api.js';

import { homePage } from './pages/home.js';
import { eventPage } from './pages/event.js';
import { queuePage } from './pages/queue.js';
import { checkoutPage } from './pages/checkout.js';
import { orderPage } from './pages/order.js';
import { walletPage } from './pages/wallet.js';
import { organizerPage } from './pages/organizer.js';
import { reportPage } from './pages/report.js';

/**
 * Aplicación de una sola página, sin framework.
 *
 * El router mapea la URL a una función que devuelve un nodo (o una promesa de
 * uno). Cada página recibe `ctx` con los parámetros y un par de utilidades.
 */

const routes = [
  { path: /^\/$/, view: homePage },
  { path: /^\/e\/([^/]+)$/, view: eventPage, keys: ['slug'] },
  { path: /^\/e\/([^/]+)\/cola$/, view: queuePage, keys: ['slug'] },
  { path: /^\/checkout\/([^/]+)$/, view: checkoutPage, keys: ['holdId'] },
  { path: /^\/orden\/([^/]+)$/, view: orderPage, keys: ['code'] },
  { path: /^\/mis-entradas$/, view: walletPage },
  { path: /^\/organizador$/, view: organizerPage },
  { path: /^\/organizador\/([^/]+)\/reporte$/, view: reportPage, keys: ['slug'] },
];

const root = document.getElementById('app');
let cleanup = null;

export function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', to);
  else history.pushState({}, '', to);
  render();
}

/** Intercepta los clics en enlaces internos para no recargar la página. */
document.addEventListener('click', (e) => {
  const link = e.target.closest?.('a[href^="/"]');
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || link.target === '_blank') return;
  e.preventDefault();
  navigate(link.getAttribute('href'));
});

window.addEventListener('popstate', () => render());
onSessionChange(() => render());

async function render() {
  cleanup?.();
  cleanup = null;

  const path = location.pathname;
  const match = routes
    .map((route) => ({ route, m: route.path.exec(path) }))
    .find(({ m }) => m);

  clear(root);
  root.append(shell(h('div.wrap.stack', { style: { paddingTop: '26px' } }, loading())));
  root.setAttribute('aria-busy', 'true');

  if (!match) {
    clear(root);
    root.append(
      shell(
        h('div.wrap.narrow.stack', { style: { paddingTop: '60px', textAlign: 'center' } }, [
          h('h1', 'No encontramos esa página'),
          h('p.muted', 'Puede que el evento haya terminado o que el enlace esté mal.'),
          h('a.btn', { href: '/' }, 'Ver todos los eventos'),
        ])
      )
    );
    root.removeAttribute('aria-busy');
    return;
  }

  const params = {};
  (match.route.keys || []).forEach((key, i) => {
    params[key] = decodeURIComponent(match.m[i + 1]);
  });

  const ctx = {
    params,
    navigate,
    /** Registra trabajo a cancelar cuando el usuario se va de la pantalla. */
    onLeave(fn) {
      const prev = cleanup;
      cleanup = () => {
        prev?.();
        fn();
      };
    },
    requireLogin,
  };

  try {
    const view = await match.route.view(ctx);
    clear(root);
    root.append(shell(view));
    // Marca de "ya arrancó": apaga el cartel de ayuda que trae index.html.
    root.dataset.booted = 'yes';
    window.scrollTo({ top: 0 });
  } catch (err) {
    clear(root);
    root.append(
      shell(
        h('div.wrap.narrow.stack', { style: { paddingTop: '48px' } }, [
          h('h1', 'Algo salió mal'),
          h('p.muted', err instanceof ApiError ? err.message : 'Probá de nuevo en un momento.'),
          h('a.btn.ghost', { href: '/' }, 'Volver al inicio'),
        ])
      )
    );
    if (!(err instanceof ApiError)) console.error(err);
  } finally {
    root.removeAttribute('aria-busy');
  }
}

function loading() {
  return [
    h('div.skeleton', { style: { height: '34px', width: '240px' } }),
    h('div.grid', [0, 1, 2].map(() => h('div.skeleton', { style: { height: '210px' } }))),
  ];
}

// ─── Cáscara: barra superior y pie ───────────────────────────────────────────

function shell(content) {
  const user = session.user;
  const frag = document.createDocumentFragment();

  frag.append(
    h('header.top', h('div.wrap.inner', [
      h('a.logo', { href: '/' }, [h('span.mark', '3'), 'Tres Tickets']),
      h('nav.links', [
        navLink('/', 'Eventos'),
        navLink('/mis-entradas', 'Mis entradas'),
        user?.role === 'organizer' ? navLink('/organizador', 'Organizador') : null,
        user
          ? h(
              'button.link-btn',
              {
                style: { marginLeft: '8px' },
                onclick: () => {
                  session.clear();
                  toast('Cerraste sesión');
                },
              },
              user.name.split(' ')[0]
            )
          : h('button.btn.small', { onclick: () => requireLogin() }, 'Entrar'),
      ]),
    ])),
    h('main', content),
    h('footer.foot', h('div.wrap', [
      h('p', 'Tres Tickets — precio final desde el principio, cola por orden de llegada y sin reventa: si no podés ir, la transferís o te la devolvemos.'),
      h('p.faint', 'Proyecto de demostración. Los pagos son simulados y no se cobra nada.'),
    ]))
  );
  return frag;
}

function navLink(href, label) {
  return h('a', { href, 'aria-current': location.pathname === href ? 'page' : null }, label);
}

/**
 * Pide identificarse solo cuando hace falta de verdad (al pagar), no al entrar.
 * Devuelve una promesa con el usuario, o null si cancela.
 */
export function requireLogin(reason = 'Necesitamos tu email para emitir la entrada.') {
  if (session.user) return Promise.resolve(session.user);

  return new Promise((resolve) => {
    const close = modal(() => {
      const email = h('input', { type: 'email', required: true, placeholder: 'vos@email.com' });
      const name = h('input', { type: 'text', placeholder: 'Nombre y apellido' });
      const error = h('div.notice.bad', { hidden: true });

      const form = h('form.stack', {
        onsubmit: async (e) => {
          e.preventDefault();
          const button = form.querySelector('button[type=submit]');
          button.disabled = true;
          try {
            const res = await api.login(email.value.trim(), name.value.trim());
            session.save(res.token, res.user);
            close();
            resolve(res.user);
          } catch (err) {
            error.textContent = err.message || 'No pudimos entrar';
            error.hidden = false;
            button.disabled = false;
          }
        },
      }, [
        h('h2', 'Entrá con tu email'),
        h('p.muted', { style: { fontSize: '0.9rem' } }, reason),
        error,
        h('label.field', [h('span', 'Email'), email]),
        h('label.field', [h('span', 'Nombre'), name]),
        h('div.row', { style: { marginTop: '6px' } }, [
          h('button.btn.grow', { type: 'submit' }, 'Continuar'),
          h('button.btn.ghost', {
            type: 'button',
            onclick: () => {
              close();
              resolve(null);
            },
          }, 'Ahora no'),
        ]),
        h('p.faint', 'Sin contraseña: en producción esto sería un enlace mágico al correo.'),
      ]);
      return form;
    });
  });
}

/**
 * Último recurso: si algo revienta antes de que se dibuje la primera pantalla,
 * mostramos el error en la página. Una pantalla en blanco no le dice nada a
 * nadie; el mensaje, aunque sea feo, al menos se puede copiar y buscar.
 */
function bootFailure(error) {
  console.error('Tres Tickets no pudo arrancar:', error);
  const app = document.getElementById('app');
  if (!app || app.dataset.booted === 'yes') return;
  clear(app);
  app.append(
    h('div.wrap.narrow.stack', { style: { paddingTop: '12vh' } }, [
      h('h1', 'La aplicación no pudo arrancar'),
      h('p.muted', 'Revisá que el servidor esté corriendo (npm start) y recargá la página.'),
      h('pre', {
        style: {
          background: 'var(--surface-2)',
          padding: '14px 16px',
          borderRadius: '10px',
          overflowX: 'auto',
          fontSize: '0.85rem',
        },
      }, String(error?.stack || error)),
    ])
  );
}

window.addEventListener('error', (e) => bootFailure(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => bootFailure(e.reason));

append(document.body, []);
render().catch(bootFailure);
