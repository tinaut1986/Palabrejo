# Spec 007 — Estructura modular (server y cliente)

- **Estado:** por implementar
- **Areas:** estructura
- **Relacionada con:** Spec 008 (hacer los tests de integración antes o en
  paralelo para poder refactorizar con red de seguridad)

## Objetivo

Los dos monolitos (1239 líneas de `server.js` y 1656 de `public/js/main.js`)
mezclan responsabilidades y duplican lógica:
`normalizeForMatch` (servidor, `lib/game-logic.js:136`) y `canonicalLetter`
(cliente, `main.js:710`) hacen lo mismo. Además:
- `multipleStatements: true` queda activo en el pool entero por las migraciones.
- El objeto `rooms = {}` y sus timers no tienen ciclo de vida propio.
- La UI ensambla HTML en un solo archivo con `window.joinRoom` colgado en global.

## Alcance

- **Servidor:** separar en módulos coherentes:
  - `src/routes/*` (auth, perfil, amigos) — hoy 244...519.
  - `src/game/rooms.js` (estado de salas, timers, creado/borrado) — hoy 70...97.
  - `src/game/round.js` (ronda, bonus, fin de partida) — hoy 1024...1282.
  - `src/socket/handlers.js` (registro de eventos) — hoy 696...978.
  - Conexión dedicada para migraciones (`multipleStatements` solo ahí);
    el resto del pool sin ese flag.
- **Cliente:** trocear `main.js` en roles (networking, auth, lobby/rooms,
  builder, resultados, amigos/perfil, accesibilidad), con un pequeño store de
  estado y helpers compartidos (normalización de letras).
- Extraer la normalización a un módulo compartido (sino el protocolo : "un solo
  lugar para `normalizeForMatch`/"canonicalLetter").
- Mover `joinRoom` del global `window` a un dispatcher de eventos normal.

- Fuera de alcance: reescribir la lógica de juego, cambiar protocolo de socket,
  introducir bundler/framework. Solo reorganizar.

## Enfoque / diseno

- Primero Spec 008 (tests de integración). Luego refactor *por pasadas*,
  cada una con PR propio y tests pasando en verde: 1) pure functions fuera,
  2) rutas HTTP, 3) handlers de socket, 4) cliente por módulos.
- Sin cambios de comportamiento: los criterios de aceptación son "nada cambia".

## Criterios de aceptacion

- [ ] `server.js` queda como bootstrap (<150 líneas) que monta módulos.
- [ ] `require('./lib/game-logic')` y helpers compartidos son los únicos puntos
  de normalización de letras.
- [ ] `multipleStatements` solo en la conexión de migraciones.
- [ ] Tests de game-logic y de integración verdes antes y después.
- [ ] El cliente carga sin errores y el juego se ve/juega idéntico.

## Impacto

- Todo el código: `server.js`, `lib/`, `public/js/`, `package.json`, `__tests__/`.

## Referencias

- Duplicación de normalización: `lib/game-logic.js:136` vs `public/js/main.js:710`.