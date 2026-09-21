# Spec 006 — Accesibilidad

- **Estado:** por implementar
- **Areas:** diseno
- **Relacionada con:** Spec 001 y 002 (si añaden elementos visuales)

## Objetivo

La UI depende sobre todo del color y no declara regiones vivas: los fallos se
comunican solo por color/fondo, no hay `aria-live`, el foco no se gestiona al
cambiar de vista y los lectores de pantalla no se enteran de nada.

## Alcance

- `aria-live="polite"` en: feedback de palabras (`#word-feedback`),
  resultados de ronda y marcador.
- Mover el foco a un elemento con significado al cambiar de vista (al menos en
  las transiciones principales: setup→lobby→sala→juego).
- Información no solo por color: etiqueta de texto junto a las fichas que hoy
  solo cambian de tinte, y estado de bonus (x2, +5, robo) ya tiene texto pero
  verificar branding para daltónicos (divisa "▼/▲/⚔" ya existe en bonus).
- Contraste: revisar `--text-dim` y los colores de warning/danger bajo AA.
- Enfoque visible consistente (los botones de tecla del rack ya lo tienen;
  revisar steppers y selects).
- `prefers-reduced-motion` ya se respeta en la animación de letras; extenderlo a
  los nuevos efectos (ver Spec 001).

- Fuera de alcance: navegación 100% por teclado de todas las pantallas (se
  revisa pero no se rediseña el layout).

## Enfoque / diseno

- Cambios localizados en HTML (atributos ARIA) y main.js (foco), más una pasada
  de contrastes en `style.css`. Sin tocar estructura ni comportamiento.

## Criterios de aceptacion

- [ ] Un lector de pantalla anuncia el feedback de cada palabra y el resultado
  de cada ronda.
- [ ] Cada cambio de vista deja el foco en un elemento útil.
- [ ] Ningún estado se comunica únicamente con color (verificar con simulador
  de daltonismo y escala de grises).
- [ ] Los textos principales cumplen contraste AA (comprobar con axe/contrast).

## Impacto

- `public/index.html`, `public/js/main.js`, `public/style.css`.

## Referencias

- `showFeedback` en `main.js:568`; color de estado en `style.css` (`--accent`, etc.).