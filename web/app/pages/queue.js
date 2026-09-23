import { h, countdown, plural, toast } from '../ui.js';
import { api, queueStore } from '../api.js';

/**
 * Sala de espera.
 *
 * Lo único que pide un usuario en una cola es saber la verdad: cuántos tiene
 * adelante, cuánto falta y que no va a perder el lugar. Esta pantalla muestra
 * las tres cosas y se actualiza sola cada tres segundos. El token está guardado
 * en el navegador: se puede cerrar y volver.
 */

export async function queuePage(ctx) {
  const { slug } = ctx.params;
  const token = queueStore.get(slug);

  if (!token) {
    ctx.navigate(`/e/${slug}`, { replace: true });
    return h('div');
  }

  const { event } = await api.event(slug);
  let status = await api.queueStatus(token);
  const initialAhead = Math.max(status.ahead, 1);

  const number = h('div.queue-number');
  const caption = h('p.muted');
  const eta = h('p.faint');
  const bar = h('div.progress', h('i'));
  const admitted = h('div', { hidden: true });

  function paint() {
    if (status.status === 'admitted') {
      number.textContent = '¡Te toca!';
      caption.textContent = 'Ya podés elegir tus lugares.';
      eta.textContent = status.seconds_left
        ? `Tenés ${countdown(status.seconds_left)} para completar la compra.`
        : '';
      bar.querySelector('i').style.width = '100%';
      admitted.hidden = false;
      admitted.replaceChildren(
        h('a.btn.block', { href: `/e/${slug}` }, 'Elegir mis lugares')
      );
      return;
    }

    if (status.status === 'expired' || status.status === 'used') {
      number.textContent = '—';
      caption.textContent =
        status.status === 'used'
          ? 'Ya usaste este turno.'
          : 'Se venció tu turno. Podés volver a la cola.';
      admitted.hidden = false;
      admitted.replaceChildren(
        h('button.btn.block', {
          onclick: async () => {
            const fresh = await api.joinQueue(slug);
            queueStore.set(slug, fresh.token);
            status = fresh;
            paint();
          },
        }, 'Volver a la cola')
      );
      return;
    }

    number.textContent = status.ahead === 0 ? 'Sos el próximo' : String(status.ahead);
    caption.textContent =
      status.ahead === 0
        ? 'Entrás en cuanto se libere un lugar.'
        : `${plural(status.ahead, 'persona adelante', 'personas adelante')} tuyo.`;
    eta.textContent = status.eta_seconds
      ? `Tiempo estimado: ${countdown(status.eta_seconds)}`
      : '';
    const done = Math.max(0, initialAhead - status.ahead);
    bar.querySelector('i').style.width = `${Math.min(96, (done / initialAhead) * 100)}%`;
  }

  paint();

  const timer = setInterval(async () => {
    try {
      const next = await api.queueStatus(token);
      const justAdmitted = status.status !== 'admitted' && next.status === 'admitted';
      status = next;
      paint();
      if (justAdmitted) toast('¡Es tu turno! Ya podés elegir tus lugares');
    } catch {
      /* un error puntual de red no cancela la espera */
    }
  }, 3000);

  ctx.onLeave(() => clearInterval(timer));

  return h('div.wrap.narrow.stack', { style: { paddingTop: '30px', '--gap': '18px' } }, [
    h('div.stack', { style: { '--gap': '4px' } }, [
      h('p.faint', { style: { margin: 0 } }, 'Cola de espera'),
      h('h1', event.title),
    ]),
    h('div.card.queue-hero.stack', [number, caption, bar, eta, admitted]),
    h('div.card.stack', { style: { '--gap': '8px' } }, [
      h('h3', 'Cómo funciona esta cola'),
      h('ul.muted', { style: { margin: 0, paddingLeft: '20px', fontSize: '0.92rem' } }, [
        h('li', 'El orden es por llegada y tu posición nunca empeora.'),
        h('li', 'Podés cerrar esta pestaña: tu lugar queda guardado en este dispositivo.'),
        h('li', 'Refrescar no te manda al final de la fila.'),
        h('li', `Cuando entres vas a tener ${Math.round(event.admit_ttl_secs / 60)} minutos para comprar.`),
      ]),
    ]),
    h('a.link-btn', { href: `/e/${slug}` }, 'Ver la información del evento'),
  ]);
}
