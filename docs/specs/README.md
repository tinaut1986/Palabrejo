# Especificaciones de Palabrejo

Cada mejora grande se escribe aquí como una **spec** antes de tocarse el código.
La spec es la fuente de verdad de *qué* se quiere y *por qué*; los detalles
técnicos se resuelven en la implementación. Se versionan junto al código.

## Indice

Orden aproximado por prioridad (indicativo, se reordena con milestones).

| # | Spec | Estado |
|---|------|--------|
| 001 | [Sonido y celebraciones](001_sonido_y_celebracion.md) | por implementar |
| 002 | [Progreso de ronda (X de Y palabras)](002_progreso_ronda.md) | por implementar |
| 003 | [Rate-limit y throttling](003_rate_limit.md) | por implementar |
| 004 | [QR local, sin API externa](004_qr_local.md) | por implementar |
| 005 | [PWA offline y fuentes locales](005_pwa_offline.md) | por implementar |
| 006 | [Accesibilidad](006_accesibilidad.md) | por implementar |
| 007 | [Estructura modular (server y cliente)](007_estructura_modular.md) | por implementar |
| 008 | [Tests de integración (salas y sockets)](008_tests_integracion.md) | por implementar |
| 009 | [Dificultad de tablero configurable](009_dificultad.md) | por implementar |
| 010 | [Combos y rachas](010_combos_rachas.md) | por implementar |
| 011 | [Configuración entre partidas](011_config_descanso.md) | por implementar |
| 012 | [Chat de sala](012_chat_sala.md) | por implementar |
| 013 | [Poderes y bonus de jugabilidad](013_poderes_jugabilidad.md) | por implementar |
| 014 | [Logros y ranking enriquecido](014_logros_ranking.md) | por implementar |
| 015 | [Salud de salas (sweep, anti-AFK, host)](015_salud_salas.md) | por implementar |

## Cómo trabajar con specs

El flujo completo está en [AGENTS.md](../../AGENTS.md). Resumen:

1. **Nueva idea** → se escribe una spec con la plantilla `000_template.md`.
2. **Spec lista** → se crea un issue de implementación que la referencia.
3. **Implementación** → branch `feat/<nombre>`, PR que cierra el issue.
4. **Terminada** → estado "hecho" y actualizado en el índice de arriba.

## Estados

- **borrador**: la idea está en pañales, puede cambiar.
- **lista para implementar**: los criterios de aceptación están claros.
- **en curso**: alguien (o una IA) está implementándola.
- **hecho**: mergeada y verificada contra sus criterios.