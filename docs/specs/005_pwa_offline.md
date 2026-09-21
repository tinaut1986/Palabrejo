# Spec 005 — PWA offline y fuentes locales

- **Estado:** por implementar
- **Areas:** estructura, infra
- **Relacionada con:** Spec 004

## Objetivo

El `manifest.webmanifest` declara el juego como PWA instalable, pero no hay
*service worker*: sin conexión no carga nada, y los iconos están a medias.
Además las fuentes (Inter) se cargan de `fonts.googleapis.com`, una dependencia
externa más en cada visita.

## Alcance

- `service-worker.js` que cachea el shell (HTML, CSS, JS, manifest, iconos,
  fuentes) y sirve offline ante fallo de red (estrategia shell + red).
- Registro del SW en `public/index.html` (registro "de mejora": nunca romper la
  app si el SW falla).
- Descargar Inter y servirla local, con `font-display: swap`.
- Repasar los iconos faltantes que referencie el manifest.
- Estrategia de caché que **no sirva estados viejos de partida**: solo ficheros
  estáticos, nunca datos de socket/DOM.

- Fuera de alcance: sincronización offline de partidas (el juego es en tiempo
  real y online por diseño).

## Enfoque / diseno

- SW pequeño en `public/sw.js`, precac head del shell (precache automático de
  lo que se amarra en el evento `install`).
- No caché opaca del HTML raíz con `?join=XXXX`: los enlaces de invitación deben
  llegar al servidor.

## Criterios de aceptacion

- [ ] En modo offline (DevTools → offline) el shell carga y muestra el setup.
- [ ] Las partidas online siguen funcionando exactamente igual.
- [ ] La app abre un enlace `?join=CODE` correctamente (no cacheado).
- [ ] Cero peticiones a dominios de fuentes externos al cargar la página.

## Impacto

- `public/sw.js` (nuevo), `public/index.html`, `public/style.css`,
  `public/manifest.webmanifest`, assets en `public/images/`.

## Referencias

- Carga de fuentes en `public/index.html:15-17`.