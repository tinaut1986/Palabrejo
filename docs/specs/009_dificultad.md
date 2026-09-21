# Spec 009 — Dificultad de tablero configurable

- **Estado:** por implementar
- **Areas:** jugabilidad
- **Relacionada con:** crear sala (config)

## Objetivo

Hoy un tablero se elige solo por "máximo de palabras jugables" con tamaño de
letras aleatorio (6-8). No hay distinción de nivel: un principiante y un
veterano juegan el mismo reparto. Se propone un nivel por sala (fácil / normal /
difícil) que module el reto real del tablero.

## Alcance

- Nueva opción al crear sala (junto a modo/rondas/tiempo, default "normal").
- El nivel ajusta la **longitud** del tablero y/o la **exigencia de palabras**:
  - Fácil: 6-7 letras, más palabras jugables y ≥3 vocales.
  - Normal: igual que hoy (comportamiento actual).
  - Difícil: 8+ letras, menos palabras jugables, sin garantía de muchas
    cortas; recompensa mejor las largas (ver Spec 010, combos).
- `selectPlayableLetters` recibe el nivel y afina el *score* de candidatos
  (hoy solo maximiza la cantidad de palabras jugables).

- Fuera de alcance: dificultad dinámica durante la partida; tableros temáticos
  (verbos, animales...).

## Enfoque / diseno

- Extender `selectPlayableLetters` con un parámetro `difficulty` puro (testeable
  en `game-logic`): decide número objetivo de letras y umbral de `minWords`.
- La sala guarda `difficulty`, se muestra en el resumen (como el modo) y se
  comparte en `getRoomStateForClient`.

## Criterios de aceptacion

- [ ] Al crear sala se elige dificultad y aparece en el resumen de espera.
- [ ] Fácil nunca sale con menos de 3 vocales ni con tableros pobres.
- [ ] Difícil produce tableros con menos jugables y/o más largos que normal.
- [ ] El PALABREJO sigue garantizado en los tres niveles.
- [ ] Unitarios nuevos en `game-logic.test.js`.

## Impacto

- `lib/game-logic.js` (`selectPlayableLetters`), `server.js`, `public/index.html`
  (config), `public/js/main.js` (resumen, creación).

## Referencias

- `selectPlayableLetters` en `lib/game-logic.js:277-313`.