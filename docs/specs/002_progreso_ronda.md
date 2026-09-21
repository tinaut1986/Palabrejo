# Spec 002 — Progreso de ronda (X de Y palabras)

- **Estado:** por implementar
- **Areas:** diseno, jugabilidad
- **Relacionada con:** Spec 007 (calculo de playables compartido)

## Objetivo

El jugador no sabe cuántas palabras formables hay en el tablero ni si está
aprovechando la ronda. Al terminar, `roundMissedWords` ya le muestra las que se
le escaparon, pero falta el dato cuantitativo: **"encontraste X de Y palabras
posibles"** con un anillo de progreso.

## Alcance

- El servidor calcula el total de palabras jugables de la ronda
  (`countPlayableWords`) y lo incluye en `roundEnd`.
- El cliente muestra, por jugador y para uno mismo, X de Y + porcentaje.
- Anillo de progreso para el propio jugador en la vista de resultados de ronda.
- Repetir el resumen al terminar la partida (X de Y en el total acumulado).

- Fuera de alcance: ranking "porcentaje de aprovechamiento" histórico; eso va en
  la spec de logros/ranking (014).

## Enfoque / diseno

- `endRound` ya llama a `getPlayableWords`; reutilizar el mismo iterador para
  `countPlayableWords` (evitar recorridos duplicados de un diccionario de
  ~108k palabras).
- El evento `roundEnd` lleva `playableCount` / `foundCount` por jugador.

## Criterios de aceptacion

- [ ] En resultados de ronda aparece "Has formado X de Y palabras (Z%)".
- [ ] El -porcentaje- de los demás se muestra sin chillar (texto, no anillo).
- [ ] El recuento coincide con las palabras que el server considera jugables.
- [ ] El resumen de partida también lo muestra agregado.

## Impacto

- `server.js` (`endRound`, `endGame`).
- `public/js/main.js` (`showRoundResults`, `showGameOver`) y `style.css`.

## Referencias

- `endRound` usa `getPlayableWords` en `server.js:1148`.