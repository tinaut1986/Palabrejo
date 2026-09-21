# Spec 003 — Rate-limit y throttling

- **Estado:** por implementar
- **Areas:** infra, estructura
- **Relacionada con:** ""

## Objetivo

El servidor confía en que el cliente se porte bien: no hay límite a la
frecuencia de `submitWord` ni a las peticiones de login/registro/amigos. Un
cliente modificado (o un script) podría saturar el proceso con solicitudes, y el
login permite fuerza bruta de contraseñas.

## Alcance

- Throttling de `submitWord` por jugador: N intentos por ventana de tiempo;
  por encima del límite, respuesta `wordResult` con `reason: 'throttled'` sin
  castigo pero sin validar.
- Rate-limit por IP (o por socket) en los endpoints HTTP de auth
  (`/api/login`, `/api/register`): cooldown progresivo tras fallos.
- Límite de peticiones por socket (mensajes/segundo) global para los eventos de
  socket.

- Fuera de alcance: firewall, soluciones a nivel de proxy/nginx (se haría en el
  deploy, no en el contenedor).

## Enfoque / diseno

- Sencillo y sin dependencias: tablas en memoria por socket/IP con ventana
  deslizante. Basta con algo de pocas líneas a mano (el servidor ya es
  single-process).
- No bloquear para siempre: cooldowns de unos segundos que se auto-reponen.
- `resolvePlayer` y el manejo de errores actual (`socket.emit('error')`) siguen
  igual; el throttle solo descarta trabajo pesado.

## Criterios de aceptacion

- [ ] Un cliente que envía >20 palabras/segundo deja de ser procesado
  (emite `throttled`) y el servidor no se degrada.
- [ ] El login deja de responder tras 5 fallos por IP en 5 min y vuelve solo.
- [ ] No afecta a jugadores normales (límites por encima de uso real).

## Impacto

- `server.js` (handlers `submitWord`, endpoints auth).
- Tests en `__tests__/` (lógica del throttling, preferentemente pura).

## Referencias

- `submitWord` en `server.js:855`; `/api/login` en `server.js:280`.