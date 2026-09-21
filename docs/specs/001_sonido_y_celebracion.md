# Spec 001 — Sonido y celebraciones

- **Estado:** por implementar
- **Areas:** diseno
- **Relacionada con:** ""

## Objetivo

Hoy el juego solo refuerza las jugadas con vibración (`navigator.vibrate`). El
feedback sonoro es el mayor gancho de engagement que falta, y el PALABREJO o la
victoria se celebran solo con texto. Se trata de añadir micro-sonidos opcionales
y celebraciones visuales (confeti/animación) para los momentos grandes.

## Alcance

- Tonos cortos (WebAudio, sin ficheros de audio) para: palabra válida, palabra
  inválida, PALABREJO, uso de bonus, robo de puntos, fin de ronda, partida ganada.
- Toggle de sonido persistente (localStorage) en la pantalla de juego.
- Respeta `prefers-reduced-motion` (no confeti) igual que `flyLetterToWord`.
- Mute del tab del navegador: no sonar si el tab está en segundo plano.

- Fuera de alcance: música de fondo, voces, sonidos por defecto activados para
  quien no los pida.

## Enfoque / diseno

- Pista de audio *ad-hoc* con `AudioContext` (osciladores + ganancia), sin
  assets que mantener.
- Utilidad `sounds.js` (p. ej. `pluck(tone, dur, vol)`) y un helper
  `play(evento)` que decide si suena según el toggle.
- Confeti: pequeño canvas/div animado en `game-view` y en `game-over-view`.

## Criterios de aceptacion

- [ ] Suena un tono distinto en válida/inválida/PALABREJO/bonus.
- [ ] El toggle se recuerda entre partidas y sesiones.
- [ ] Nada suena con el audio del navegador deshabilitado o en segundo plano.
- [ ] Confeti en PALABREJO y en la victoria, suprimido con `prefers-reduced-motion`.

## Impacto

- `public/js/main.js` (feedback en `wordResult`, `gameOver`, `palabrejo`).
- `public/index.html` (botón de sonido) y `style.css`.

## Referencias

- Sin dependencias externas (WebAudio nativo).