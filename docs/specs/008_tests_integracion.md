# Spec 008 — Tests de integración (salas y sockets)

- **Estado:** por implementar
- **Areas:** estructura, infra
- **Relacionada con:** Spec 007 (su red de seguridad), Spec 003 (throttling)

## Objetivo

Hoy solo hay unitarios de `game-logic`. El ciclo de vida de las salas
(crear/unir, empezar, rondas, reconexión, timers de bonus) no está cubierto, y
es el corazón del server. Sin la red, cualquier refactor (Spec 007) es a ciegas.

## Alcance

- Suite de integración que arranca el server (o sus módulos) con socket.io-client:
  - crear sala + unirse + rechazos (llena, partida empezada, sala inexistente).
  - partida completa de 2 jugadores: rondas, palabras válidas/duplicadas,
    modo exclusivo, puntos.
  - reconexión (rejoinGame) con token y limpieza tras desconexión.
  - fin de partida y persistencia en BD (con MariaDB de test o DB falsa).
  - bonus: spawn, expiración, consumo y "steal".
- La BD de tests: base real MariaDB/MariaDB de test si está disponible en el
  entorno, o una capa `db` embebible que se pueda sustituir (decisión del
  implementador, siempre sin tocar la lógica).
- Extend the `npm test` script para lanzar ambas suites.

- Fuera de alcance: e2e de navegador, cobertura de la UI.

## Enfoque / diseno

- Mantener las piezas puras de `submitWord`/`endRound` testables sin timers
  reales: inyectar reloj o usar tiempos cortos configurables.
- Evitar depender del reloj real en los tests de timers de sala
  (`vi.useFakeTimers`).

## Criterios de aceptacion

- [ ] `npm test` corre unitarios + integración en un solo comando.
- [ ] Cubre al menos: join/leave, partida completa, rejoin, modo exclusivo,
  bonificación y persistencia.
- [ ] Los tests no dejan salas ni conexiones colgadas (proceso termina limpio).

## Impacto

- `__tests__/`, `jest.setup.js`, `package.json`; quizá pequeños ganchos de
  inyección en `server.js`.

## Referencias

- Suite actual: `__tests__/game-logic.test.js`, `__tests__/words.test.js`.