# Spec 012 — Chat de sala

- **Estado:** por implementar
- **Areas:** jugabilidad, diseno
- **Relacionada con:** Spec 013 (mensajes y efectos podrían compartir canal)

## Objetivo

El juego es social (amigos, salas públicas, modos competitivos) pero no hay
ninguna comunicación en vivo: ni mínimo chat ni avisos accionables. Un chat
corto por sala cubre el "¡hola!", "otra ronda más" y las reacciones de
partida, sin herramienta externa.

## Alcance

- Chat por mensajes de texto en la sala (waiting, juego y descanso).
- Histórico corto en memoria (últimas ~50 líneas por sala), sin persistencia.
- Sanitización: longitud máxima (p. ej. 140), sin HTML, filtro de
  controlarle; el emisor no se fía del nombre (igual que en `resolvePlayer`).
- Rate-limit por jugador (ver Spec 003) para evitar spam.
- Desplegable en `game-view` y en la sala de espera; no impide jugar (el envío
  de palabras sigue en su sitio). Feedback `aria-live` (Spec 006).

- Fuera de alcance: mensajes privados, emojis renderizados ricos, persistencia,
  chat entre partidas desde el hall.

## Enfoque / diseno

- Evento `roomChat` (entrada/salida) gestionado igual que el resto: el server
  valida, formatea `{playerId, playerName, text, ts}` y lo re-emite a la sala.
- El cliente pinta con delegación de eventos como hace con las listas.

## Criterios de aceptacion

- [ ] Se puede enviar/recibir mensajes en la sala y durante la partida.
- [ ] Texto saneado (sin HTML inyectado) y límite de longitud.
- [ ] Más de N mensajes/segundo de un jugador se descartan con aviso.
- [ ] El histórico no sobrevive al cierre de la sala.

## Impacto

- `server.js` (handler `roomChat`), `public/index.html`, `public/js/main.js`,
  `style.css`.

## Referencias

- Sanitización existente de nombres: `sanitizeGuestName` en `lib/game-logic.js:143`.