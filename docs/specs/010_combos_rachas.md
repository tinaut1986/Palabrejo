# Spec 010 — Combos y rachas

- **Estado:** por implementar
- **Areas:** jugabilidad
- **Relacionada con:** Spec 002 (progreso), Spec 013 (poderes)

## Objetivo

La puntuación solo depende de la longitud. Añadir **rachas** para premiar la
constancia y la velocidad: encadenar palabras válidas sin fallar o el orden en
que se encuentran, sin cambiar las reglas básicas.

## Alcance

- **Racha de aciertos**: cada palabra válida consecutiva (sin fallo intermedio)
  suma un multiplicador creciente por ronda (p. ej. +1, +2... hasta un tope
  como +5). Un fallo resetea la racha.
- **Bonus por velocidad**: las primeras palabras de la ronda valen un poco más
  que las del final (ventana inicial tipo "quick start", transparente para el
  jugador: "¡primera de la ronda, +2!").
- La racha y el bonus se muestran en el cliente (badge junto a la puntuación de
  ronda) y se tienen en cuenta en `calculateScore`/deducción, siempre server-side.
- En modo exclusivo, la racha cuenta igual (sin castigo extra por `used_by_other`).

- Fuera de alcance: rachas entre rondas/partidas, tabla de rachas global
  (va a la spec de logros/ranking 014).

## Enfoque / diseno

- Pura en `lib/game-logic.js` (`applyStreak`, `streakBonus`) para unitarlos.
- El server calcula el estado de racha por jugador dentro de la ronda
  (`player.streak`) y lo emite en `wordResult`/`roomStateUpdate`.
- Los puntos extra por velocidad salen de una constante (p. ej.
  `RAPID_FIRST_SECONDS`) calculada con `roundEndsAt`.

## Criterios de aceptacion

- [ ] Encadenar 3+ palabras incrementa el bonus y se ve en la UI.
- [ ] Un fallo reinicia la racha y el jugador lo nota (feedback).
- [ ] Las dos primeras palabras rápidas de cada ronda puntúan más, con aviso.
- [ ] Los totales del server son autoritativos (el cliente solo pinta).
- [ ] Unitarios de racha/multiplicador en `game-logic.test.js`.

## Impacto

- `lib/game-logic.js`, `server.js` (`submitWord`, `startRound`, `endRound`),
  `public/js/main.js` (UI).

## Referencias

- `calculateScore` en `lib/game-logic.js:122`.