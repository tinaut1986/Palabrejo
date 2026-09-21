# Spec 013 — Poderes y bonus de jugabilidad

- **Estado:** por implementar
- **Areas:** jugabilidad
- **Relacionada con:** Spec 010 (combos), Spec 012 (canal de avisos)

## Objetivo

Los bonus de letras (x2, +5, robo...) son el único ingrediente táctico. Se
propone un nivel más de decisiones rápidas: **poderes de un solo uso** que el
jugador activa durante la ronda, además de premiar jugadas concretas de
apertura.

## Alcance

- **Poderes** (adicionales, no sustitutivos de los bonus de letras):
  - 🔀 *Mazo*: baraja automática gratis (sin consumir turno).
  - 💡 *Pista*: revela una letra de una palabra jugable pendiente (a elección
    del jugador, sin decir cuál).
  - ❄️ *Congelar*: a un rival, 5s sin poder enviar.
  - ⏳ *Doble ráfaga*: 30s con palabras enviadas al doble.
  - ➖ *Anular*: elimina una letra del tablero para el resto de la ronda
    (rompe PALABREJOs: compensar puntuándolos igual si ya usaban la letra).
- Cada poder se reparte al inicio (1 por jugador/ronda muy variable) y se
  consume al usarlo; se activa con un botón en el dock.
- **Bonus de apertura**: la primera palabra válida de la ronda lleva un bonus
  anunciado ("¡primero, +X!").
- Todos los efectos los calcula y valida el server (nunca el cliente).
- Avisos a la sala de quién usa qué y contra quién (canal de Spec 012).

- Fuera de alcance: tienda/compra de poderes, persistencia entre rondas.

## Enfoque / diseno

- Modelo de datos server: `player.powers[]` por ronda, `applyPower(type, target)`
  con efectos de corta duración (timers reales simple) o permanentes de ronda
  (anular). Extender `rollBonus`/`applyBonus` (game-logic) con `rollPower`.
- Pura y testeable en `lib/game-logic.js`; los timers en `server.js`.

## Criterios de aceptacion

- [ ] Los 5 poderes funcionan end-to-end y solo los aplica el server.
- [ ] Un poder y un bonus de letra no se pisan mal (efectos acumulables o
  definidos a priori).
- [ ] Cada poder es de un solo uso y se pierde al terminar la ronda.
- [ ] El bonus de primera palabra aparece anunciado y puntúa.
- [ ] Unitarios de `applyPower`/`rollPower`.

## Impacto

- `lib/game-logic.js`, `server.js` (`submitWord`, `startRound`, nuevos handlers),
  `public/index.html` (dock de poderes), `public/js/main.js`, `style.css`.

## Referencias

- Bonus actuales: `BONUS_TYPES`/`applyBonus` en `lib/game-logic.js:68-109`.