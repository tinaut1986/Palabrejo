# AGENTS.md — Guía de trabajo para agentes IA

Repo: **tinaut1986/Palabrejo** — juego web multijugador de formar palabras
(código en `/mnt/disk2/Scripts/docker/palabrejo` en la máquina local; desplegado
como contenedor `palabrejo_server`).

Esta guía sirve para cualquier agente (opencode, Claude/Cursor, etc.). Léela
**antes** de tocar nada. Si usas Claude, `CLAUDE.md` apunta aquí.

## Resumen

- **Stack:** Node.js + Express 5 + Socket.IO; MariaDB (mysql2); frontend
  HTML/CSS/JS vanilla; Docker.
- **Convención ABSOLUTA:** el servidor es autoritativo en todo (puntos,
  identidad, validación de palabras). El cliente solo pinta y envía.
- **Idioma:** la UI y los comentarios/mensajes van en **español**. Los mensajes
  de commit, en español, estilo conventional (`feat:`, `fix:`, `refactor:`, ...).

## Cómo ejecutar y verificar

```bash
npm install
npm test          # unitarios + integración (jest); necesita MariaDB accesible (ver docs/FUNCIONAMIENTO.md)
npm start         # arranca en :3000 (HTTP)
```

- Docker: `docker build -t palabrejo .` + `docker run -p 3000:3000 -v "$PWD/config.js:/app/config.js:ro" palabrejo`.
- El arranque aplica migraciones de `migrations/` automáticamente.
- **Siempre** que toques código, ejecuta `npm test` (y el lint si existiera).

## Estructura

- `server.js` — backend completo (monolito; refactor en issue #7).
- `lib/game-logic.js` — lógica pura y testeable (puntuación, letras, bonus).
- `public/` — frontend: `index.html`, `style.css`, `js/main.js` (monolito) ,
  imágenes, manifest PWA.
- `migrations/` — SQL versionado con `NNN_nombre.sql` (idempotente).
- `__tests__/` — unitarios de game-logic.
- `scripts/` — importación de diccionario, reset de contraseñas.
- `docs/FUNCIONAMIENTO.md` — cómo funciona todo por dentro (arquitectura,
  reglas de juego, protocolo de sockets). **Actualízalo** si tu cambio toca
  algo ahí descrito (ver "Documento de funcionamiento" más abajo).

## Flujo de trabajo (issues)

El backlog vive **solo en issues de GitHub**, sin ficheros de spec aparte
(evita el papeleo duplicado de mantener un `.md` y un issue que solo apunta
a él). El cuerpo del issue ES la spec: objetivo, alcance, criterios de
aceptación — como cualquier issue bien escrito.

1. **Idea nueva** → `gh issue create` con el detalle en el body (qué, por
   qué, criterios de aceptación comprobables). Label según área
   (`estructura`, `diseno`, `jugabilidad`, `tech-debt`) + `bug` si aplica.
2. **Implementar** → branch `feat/<slug>` (o `fix/<slug>` para bugs). El PR
   debe decir `Closes #<issue>`.
3. **Terminada** → PR mergeado cierra el issue solo. Si el cambio toca
   `docs/FUNCIONAMIENTO.md`, la actualización va en el mismo PR.

### Trabajo conversacional (sesión en vivo)

Cuando el usuario pide un cambio directamente en el chat (no desde el
backlog de issues), no hace falta abrir issue antes de tocar código: se
implementa, se verifica y se commitea/pushea **solo cuando el usuario lo
pida explícitamente**. Si el cambio es sustancial y merece quedar
documentado para el futuro, se abre el issue a posteriori (ya cerrado, como
registro) o se actualiza `docs/FUNCIONAMIENTO.md` si cambia lógica.

### Convenciones del flujo

- **Un PR por tema.** No mezcles features ni refactors en el mismo PR
  (salvo trabajo conversacional consolidado en una sesión, que puede ir en
  un único commit si el usuario no pide separarlo).
- **No cambies la API/eventos de socket** sin actualizar servidor Y cliente
  juntos (van en el mismo PR o commit).
- **Notas en el body del PR**: qué cambia, cómo se verificó, capturas si toca.
- Labels: `estructura`, `diseno`, `jugabilidad`, `tech-debt`, `bug`.

## Documento de funcionamiento

`docs/FUNCIONAMIENTO.md` es el resumen técnico vivo de cómo funciona el
juego (arquitectura, ciclo de vida de sala, reglas de puntuación, bonus,
protocolo de sockets...). **Tras cerrar un issue o hacer un cambio que
altere algo ahí descrito, actualiza la sección correspondiente en el mismo
PR/commit.** Si el cambio es solo estético o no afecta a nada descrito ahí,
no hace falta tocarlo.

## Convenciones de código

- **No añadas comentarios al código** salvo que lo pida el usuario o el clima
  del archivo lo exija (las funciones críticas de server.js ya los usan).
- Sé consistente: CommonJS (`require`), sin bundler ni framework.
- SQL: parámetros (`?`) siempre, nunca concatenación.
- Identidad de usuarios: **nunca** confiar en el nombre/`userId` del cliente;
  resolvela en el server (`resolvePlayer`/`verifySession`).
- Puntuación y validaciones: siempre en `lib/game-logic.js` (puro, testeable).
- La normalización de letras tiene UN solo lugar canónico:
  `normalizeForMatch` (issue #7 lo unifica). No la dupliques.

## GitHub

- Repo remoto: `git@github.com:tinaut1986/Palabrejo.git`, rama base `main`.
- `gh` está autenticado como tinaut1986. Comandos útiles:
  `gh issue create/close`, `gh pr create`, `gh label create`.
- Trabaja donde se corra el juego (`cd /mnt/disk2/Scripts/docker/palabrejo`
  o `workdir` equivalente). OJO: `/mnt/disk2/Scripts` es un repo distinto
  (endor-automation); no confundas los remotes.
- **No hagas commit ni push sin que el usuario lo pida explícitamente.**
  Cuando lo pida: revisa `git status`, `git diff` y que no entren secretos
  (`config.js` está en `.gitignore`).

## Zonas sensibles

- `multipleStatements: true` está activo solo para migraciones (no lo uses en
  queries del pool; issue #7 lo aísla).
- El servidor es *single process* y guarda las salas en memoria: al reiniciar
  el contenedor se pierden las partidas en curso (por diseño).
- No introduzcas dependencias externas (APIs, CDNs) en el cliente sin
  justificarlo: hay issues para quitarlas (QR #4, fuentes #5).