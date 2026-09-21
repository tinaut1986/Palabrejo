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
npm test          # unitarios de game-logic (jest). Los de integración llegarán (spec 008)
npm start         # arranca en :3000 (HTTP)
```

- Docker: `docker build -t palabrejo .` + `docker run -p 3000:3000 -v "$PWD/config.js:/app/config.js:ro" palabrejo`.
- El arranque aplica migraciones de `migrations/` automáticamente.
- **Siempre** que toques código, ejecuta `npm test` (y el lint si existiera).

## Estructura

- `server.js` — backend completo (monolito; refactor en spec 007).
- `lib/game-logic.js` — lógica pura y testeable (puntuación, letras, bonus).
- `public/` — frontend: `index.html`, `style.css`, `js/main.js` (monolito) ,
  imágenes, manifest PWA.
- `migrations/` — SQL versionado con `NNN_nombre.sql` (idempotente).
- `__tests__/` — unitarios de game-logic.
- `scripts/` — importación de diccionario, reset de contraseñas.
- `docs/specs/` — specs de mejoras (ver "Flujo de trabajo").

## Flujo de trabajo (spec-driven)

Las mejoras se gestionan con **specs versionadas** + **issues** de GitHub.
El orden es siempre:

1. **Existe spec** para la idea en `docs/specs/` (plantilla `000_template.md`)?
   - No → escríbela primero: qué y por qué + criterios de aceptación. Añádela
     al índice (`docs/specs/README.md`), estado "borrador". Crea un PR que
     solo añade el `.md`.
   - El issue de implementación NO es la spec: la spec vive en el repo.
2. **Spec lista** → estado "lista para implementar" en el índice.
3. **Implementar** → issue de GitHub creado (`gh issue create` desde el repo)
   que referencia la spec por su ruta relativa. Branch `feat/<slug>`.
   El PR debe decir `Closes #<issue>`.
4. **Terminada** → estado "hecho" en el índice; PR mergeado.

### Convenciones del flujo

- **Un PR por tema.** No mezcles features ni refactors en el mismo PR.
- **No cambies la API/eventos de socket** sin actualizar servidor Y cliente
  juntos (van en el mismo PR).
- **Notas en el body del PR**: qué cambia, cómo se verificó, capturas si toca.
- Labels: `estructura`, `diseno`, `jugabilidad`, `tech-debt`, `bug`.
- Bugs → issue con label `bug`, spec no necesaria (pero sí repro).

## Convenciones de código

- **No añadas comentarios al código** salvo que lo pida el usuario o el clima
  del archivo lo exija (las funciones críticas de server.js ya los usan).
- Sé consistente: CommonJS (`require`), sin bundler ni framework.
- SQL: parámetros (`?`) siempre, nunca concatenación.
- Identidad de usuarios: **nunca** confiar en el nombre/`userId` del cliente;
  resolvela en el server (`resolvePlayer`/`verifySession`).
- Puntuación y validaciones: siempre en `lib/game-logic.js` (puro, testeable).
- La normalización de letras tiene UN solo lugar canónico:
  `normalizeForMatch` (spec 007 lo unifica). No la dupliques.

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
  queries del pool; spec 007 lo aísla).
- El servidor es *single process* y guarda las salas en memoria: al reiniciar
  el contenedor se pierden las partidas en curso (por diseño).
- No introduzcas dependencias externas (APIs, CDNs) en el cliente sin
  justificarlo: hay specs para quitarlas (QR, fuentes).