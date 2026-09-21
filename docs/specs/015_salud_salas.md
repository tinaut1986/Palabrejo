# Spec 015 — Salud de salas (sweep, anti-AFK, host)

- **Estado:** por implementar
- **Areas:** estructura, infra
- **Relacionada con:** Spec 007, Spec 003

## Objetivo

El ciclo de vida de las salas tiene huecos operativos:
- Las salas **waiting** abandonadas solo se borran cuando se quedan vacías: un
  host que cierra el navegador deja una sala huérfana para siempre (y su código
  queda quemado mientras viva el proceso).
- Un jugador dormido en **waiting** bloquea para siempre a los 11 demás.
- En partida, el host que se va transfiere el rol automáticamente, pero sin
  avisar a nadie ni dar alternativa rápida.

## Alcance

- **Sweep de salas huérfanas**: timer periódico (p. ej. cada minuto) que elimina
  salas en `waiting` sin actividad del host (misma ventana que la gracia de
  desconexión, ~2 min) y retira los códigos.
- **Anti-AFK en waiting**: expulsión/aviso del host para jugadores inactivos
  en espera (sin papeleo, botón "expulsar" del host además del aviso).
- **Transparencia del host**: aviso a la sala "X es el nuevo anfitrión" y un
  botón "convertirse en anfitrión" que pide permiso si el host está ausente.
- Los timers de desconexión/gracia ya existen (`RESUME_GRACE_MS`) y se respetan.

- Fuera de alcance: kick durante la partida (se evalúa aparte), matchmaking,
  reincorporación del host con permisos de antes del traspaso.

## Enfoque / diseno

- Un `setInterval` global de mantenimiento en el server que recorre `rooms`
  (función pura `collectStaleRooms(rooms, now)` testeable).
- La expulsión y el traspaso reutilizan `broadcastRoomState` y
  `broadcastPublicRooms` actuales.

## Criterios de aceptacion

- [ ] Una sala waiting sin actividad del host >2 min desaparece y su código se
  libera.
- [ ] El host puede expulsar a un jugador de la sala en espera (con confirmación
  del lado del cliente).
- [ ] Al traspasar host, se avisa a la sala y el nuevo puede empezar.
- [ ] Un jugador pendiente de reconexión (en gracia) no se considera huérfano.

## Impacto

- `server.js` (maintenance interval, `endRound` no se toca), quizá
  `lib/game-logic.js` para la función pura de caducidad.

## Referencias

- `detachSocketFromRooms`/`scheduleRoomCleanup` en `server.js:668` y `1009`.