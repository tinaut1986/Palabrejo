# Spec 004 — QR local, sin API externa

- **Estado:** por implementar
- **Areas:** estructura, infra
- **Relacionada con:** Spec 005 (mismo espíritu: no depender de terceros)

## Objetivo

El QR de invitación se genera con una API externa (`api.qrserver.com`). Encima,
queda código muerto (`generateQR`, un *placeholder* que no genera un QR real).
Una API de terceros implica dependencia de red, privacidad (la URL de la sala se
manda fuera) y pintadas aleatorias si falla.

## Alcance

- Generar el QR en local: bien en el servidor (paquete `qrcode`, endpoint que
  devuelva el PNG/Data URL) o en el cliente sin red.
- Eliminar `generateQR` (muerto) y el fallback de texto de `generateQRCode`.
- No romper el caché de `lastQrUrl` que evita regenerar por palabra.

- Fuera de alcance: logo en el QR, tamaños dinámicos.

## Enfoque / diseno

- Opción recomendada: librería `qrcode` (npm) usada en el **servidor**, endpoint
  `GET /api/qr?data=...` con rate-limit (ver Spec 003) para que nadie lo use
  como servicio de spam. Simétrico con el resto de API.
- Alternativa cliente (p. ej. `qrcode` en browser sin build): sopesar al
  implementar; en este repo no hay bundler, así que server-side es más limpio.

## Criterios de aceptacion

- [ ] El QR de la sala se genera sin salir del contenedor (comprobar con la
  red de la API externa cortada).
- [ ] `generateQR` y el fallback genérico del cliente desaparecen.
- [ ] Un QR escaneado abre la sala correctamente (misma URL de antes).

## Impacto

- `server.js` (nuevo endpoint), `public/js/main.js` (`generateQRCode`),
  `package.json`.

## Referencias

- `generateQR`/`generateQRCode` en `public/js/main.js:41-113`.