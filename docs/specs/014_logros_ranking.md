# Spec 014 — Logros y ranking enriquecido

- **Estado:** por implementar
- **Areas:** jugabilidad, estructura
- **Relacionada con:** Spec 002 (progreso), Spec 010 (rachas)

## Objetivo

El leaderboard ordena solo por `total_score`, y el perfil muestra 6 números. No
hay nada que invite a volver ni a presumir de destrezas concretas. Se propone
una capa de **logros** y métricas de ranking más jugosas (media, rachas,
palabrejos encontrados), apoyada en las stats que ya se persisten.

## Alcance

- **Logros** desbloqueables (server-side, con su registro en BD):
  - Primer PALABREJO, 10 PALABREJOs, racha de X victorias.
  - Encontrar el 100% de las palabras de una ronda (tira de Spec 002).
  - Racha de X aciertos seguidos en una ronda (Spec 010).
  - Ganar en exclusivo X veces; ganar con X jugadores; etc.
- **Ranking**: al menos 3 vistas nuevas aparte de puntos totales: mejor punteo,
  media, varias victorias y "palabrejos encontrados".
- **Perfil**: mostrar logros desbloqueados (iconos + fechas) y las métricas que
  hoy faltan (victorias siguientes, rachas).
- Migración SQL para las tablas (`achievements`, `user_achievements`,
  columnas en `user_stats`).

- Fuera de alcance: recompensas cosméticas/tienda, logros de invitados (solo
  cuentas, como hoy con stats).

## Enfoque / diseno

- Reglas como funciones puras evaluadas al `endGame`/`endRound`
  (`lib/achievements.js` con `evaluateAchievements(stats, gameOutcome)`),
  testeables sin BD.
- La BD solo guarda "cuándo" se desbloqueó; la lista de logros vive en código.

## Criterios de aceptacion

- [ ] Los logros se desbloquean server-side y se persisten por usuario.
- [ ] El perfil muestra desbloqueados y pendientes.
- [ ] El ranking se puede ordenar por las nuevas métricas.
- [ ] Invitados no tienen logros (sin cuenta, no hay persistencia).
- [ ] Migraciones idempotentes (mismo estilo que `001_seed_words.sql`) y tests
  de las reglas.

## Impacto

- `migrations/00X_achievements.sql`, `server.js` (admin de logros),
  `lib/achievements.js` (nuevo), `public/js/main.js` (perfil/rank), `README.md`.

## Referencias

- Persistencia actual de stats en `endGame`, `server.js:1207-1237`.