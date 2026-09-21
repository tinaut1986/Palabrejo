# Spec 011 — Configuración entre partidas

- **Estado:** por implementar
- **Areas:** jugabilidad, diseno
- **Relacionada con:** ""

## Objetivo

Al terminar una partida hay un descanso fijo de 20s y arranca una **igual** de
forma forzada (`startNewGame`). El host no puede cambiar condiciones ni los
jugadores decidir salir con calma: o recargas o vuelves al hall. Se propone hacer
del descanso una mini-pantalla con decisiones.

## Alcance

- El descanso muestra el podio + un panel del host: **otra igual**, **cambiar
  config** (rondas/tiempo/modo/dificultad/bonus) o **volver al hall**.
- Mientras el host no decide, nadie arranca (los jugadores ven "el anfitrión
  decidirá"). Si el host se va, manda su decisión y se transfiere al siguiente.
- Cuenta atrás default (los 20s actuales); si el host toca config, se pausa o
  reinicia.
- Añadir botón "otra igual en 5s" también como default táctil.

- Fuera de alcance: cola de salas, matchmaking, cambiar de jugadores en el
  descanso (se mantiene la lista actual).

## Enfoque / diseno

- Nueva vista/interacción en `restStart` en lugar de saltar directo a
  `gameOver` → `game-over-view`.
- Eventos nuevos de socket (`decideNextGame` con `{action, config?}`), y el
  server actualiza `room.pendingNextConfig` o lanza `startNewGame`.

## Criterios de aceptacion

- [ ] Tras el fin, el host elige "otra igual", "cambiar config" o "cerrar".
- [ ] Cambiar config reinicia los valores y la partida nueva los usa.
- [ ] La cuenta atrás respeta lo que decida el host (no arranca a sus espaldas).
- [ ] Si el host se desconecta en el descanso, se transfiere la decisión
  (o hereda "otra igual").

## Impacto

- `server.js` (`endGame`, `startNewGame`), `public/index.html`,
  `public/js/main.js` (descanso), `style.css`.

## Referencias

- Descanso actual: `endGame` en `server.js:1165`; `startNewGame` en `server.js:1254`.