#!/bin/sh
# ---------------------------------------------------------------------------
#  Tres Tickets — arranque para macOS y Linux
#
#  Equivalente de iniciar.cmd: se para en su propia carpeta, verifica Node,
#  levanta el servidor y abre el navegador.
#
#  Si nunca lo ejecutaste, puede hacer falta darle permiso una sola vez:
#     chmod +x iniciar.sh
# ---------------------------------------------------------------------------

cd "$(dirname "$0")" || exit 1

printf '\n  Tres Tickets\n  ============\n\n'

if ! command -v node >/dev/null 2>&1; then
  cat <<'FIN'
  [X] No encontré Node.js en esta computadora.

  Tres Tickets necesita Node.js para funcionar: es el programa que corre el
  servidor. Se instala una sola vez, desde https://nodejs.org (versión LTS).

  Después de instalarlo, cerrá esta terminal y volvé a ejecutar este archivo.

FIN
  exit 1
fi

NODE_VERSION=$(node -v)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f2)

if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  printf '  [X] Tenés Node %s, y hace falta 22.5 o más nuevo.\n\n' "$NODE_VERSION"
  printf '  La base de datos usa el SQLite que viene adentro de Node, que en\n'
  printf '  versiones anteriores no existe. Actualizalo desde https://nodejs.org\n\n'
  exit 1
fi

printf '  Node %s — listo.\n\n' "$NODE_VERSION"
printf '  Levantando el servidor… (la primera vez tarda unos segundos porque\n'
printf '  carga los eventos de ejemplo)\n\n'
printf '  Cuando termines, cerrá esta ventana o apretá Ctrl+C.\n\n'

# TT_OPEN=1 hace que el propio servidor abra el navegador, pero recién cuando
# ya está escuchando: así no hay que adivinar cuánto tarda en arrancar.
TT_OPEN=1 exec node --disable-warning=ExperimentalWarning server/src/index.js
