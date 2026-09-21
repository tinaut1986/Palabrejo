# Cómo funciona Palabrejo

Documento vivo, técnico, de referencia rápida para quien toque el código
(humano o agente IA). No es el README (eso es cara al jugador/despliegue):
esto es el resumen de la lógica interna, para no tener que releer todo
`server.js` cada vez.

**Mantenimiento:** si cierras un issue que cambia algo de lo descrito aquí
(reglas de puntuación, ciclo de vida de sala, protocolo de sockets, formato
de bonus...), actualiza la sección correspondiente en el mismo PR. Si el
cambio es solo de UI/estética sin tocar lógica, no hace falta.

## Arquitectura

- **Servidor autoritativo**: `server.js` valida todo (palabras, puntos,
  identidad). El cliente (`public/js/main.js`) solo pinta y envía intención.
- Estado de partidas **en memoria** (`rooms = {}` en `server.js`): no
  sobrevive a un reinicio del contenedor (por diseño, spec de salud de salas
  pendiente en issue #15 lo mitigará solo para salas huérfanas, no para
  partidas en curso).
- **Lógica pura y testeable** vive en `lib/game-logic.js` (puntuación,
  normalización de letras, bonus, selección de letras). Todo lo que se pueda
  testear sin sockets/DB va ahí.
- **DB** (MariaDB, `mysql2`): diccionario de palabras, usuarios/sesiones,
  amigos, stats e historial de partidas. Migraciones idempotentes en
  `migrations/`, aplicadas automáticamente al arrancar.

## Ciclo de vida de una sala

Estados de `room.gameState`: `waiting` → `playing` → `rest` → (`playing` de
nuevo, misma sala, o se cierra).

- **waiting**: sala creada, jugadores entrando. El host configura
  (jugadores, rondas, tiempo, modo, bonificaciones) y pulsa "empezar".
- **playing**: rondas en curso. Cada ronda tiene un `roundTimer` que la
  cierra sola; `endRoundManual` (solo host) y `roundTimeout` (red de
  seguridad del cliente) también la cierran.
- **rest**: tras la última ronda, pantalla de resultados + cuenta atrás
  (`NEXT_GAME_DELAY_MS`, 20s) y arranca sola una partida nueva con la misma
  gente y configuración (`startNewGame`).
- Una sala se borra si se queda sin jugadores; una desconexión en partida da
  un margen de reconexión (`RESUME_GRACE_MS`, 2 min) antes de expulsar.

## Reparto de letras y PALABREJO garantizado

- `selectPlayableLetters` (en `lib/game-logic.js`) no reparte letras al azar:
  elige las letras **distintas** de una palabra real del diccionario
  (indexadas por tamaño en `wordsByDistinctCount`, construido una vez al
  cargar el diccionario). Así esa palabra es siempre un PALABREJO posible.
- Entre varias palabras candidatas del mismo tamaño (6-8 letras distintas),
  se queda con la que más palabras jugables totales deja
  (`countPlayableWords`).
- Las letras se **barajan** antes de mandarlas al cliente — si no, salen en
  el orden de la palabra origen y delatan la solución.
- Sin diccionario indexado (tests unitarios sueltos) cae a un reparto
  aleatorio de siempre, sin garantía de PALABREJO — es un *fallback* de test,
  no pasa en producción.

## Puntuación

- Por longitud (`calculateScore`): 3=1, 4=2, 5=4, 6=7, 7+=10 puntos.
- PALABREJO (usa todas las letras del tablero, pueden repetirse):
  +15 puntos extra sobre lo anterior.
- El resultado de `calculateScore` es la "base"; luego se le puede aplicar
  un modificador de bonus/castigo (ver abajo) antes de sumarse al marcador.

## Bonus y castigos en letras del tablero

Configurable por sala (`room.bonusesEnabled`, opción al crear sala).

- Aparece un bonus/castigo sobre una letra al azar cada
  `BONUS_MIN/MAX_SPAWN_DELAY_MS` (6-14s), dura `BONUS_MIN/MAX_DURATION_MS`
  (6-12s) y se consume con la primera palabra que use esa letra (de
  cualquier jugador) o desaparece sola si nadie la usa a tiempo. Solo hay uno
  activo a la vez por sala (`room.activeBonus`).
- Tipos (`BONUS_TYPES` en `lib/game-logic.js`), elegidos al azar con su
  valor:
  - `multiply` (x2/x3): multiplica los puntos de la palabra.
  - `add` (+3/+5/+8): suma puntos fijos.
  - `divide` (÷2/÷3, castigo): divide los puntos (redondeo hacia abajo).
  - `subtract` (-3/-5/-8, castigo): resta puntos fijos.
  - `steal` (robo, 5/8 puntos): suma a quien la usa **y resta al jugador que
    va primero en la ronda** en ese momento (si no eres tú). Es el único
    tipo que perjudica a otro jugador directamente.
- Los puntos de una palabra nunca bajan de 0 por un castigo (en el peor caso
  la palabra vale 0, no resta del marcador ya acumulado).
- `player.wordPoints[wordKey]` guarda el punto final ya con el modificador
  aplicado — necesario para que el marcador en vivo y los resúmenes de
  ronda/partida cuadren (no se puede recalcular con `calculateScore` a
  secas una vez hay bonus de por medio).
- El cliente muestra un anillo con cuenta atrás sobre la letra afectada
  (color + icono: ▲ bonus, ▼ castigo, ⚔ robo — no solo color, por
  accesibilidad) y, al acertar la palabra, el desglose junto al total
  (p.ej. `+15 (11+4)`).

## Resúmenes de ronda y partida

- **Fin de ronda** (`roundEnd` + `roundMissedWords`): cada jugador ve solo
  sus palabras más largas (resto "+N más"), un top 5 de las más largas de la
  ronda con quién las encontró, y — en privado, solo para cada uno —
  hasta 8 palabras reales del diccionario que cabían en ese tablero y no
  encontró (`getPlayableWords` menos lo que encontró, ordenado por
  longitud).
- **Fin de partida** (`gameOver`): mismo patrón pero acumulado a toda la
  partida — top personal de tus más largas, las más repetidas
  (encontradas por varios jugadores o en varias rondas) y las más largas
  de toda la partida. Sin "faltantes": no tiene sentido a nivel de partida
  completa (el diccionario jugable cambia cada ronda).

## Rate-limit y throttling

En memoria, sin dependencias externas (`lib/rate-limit.js`, ventana
deslizante). Se resetea si el proceso reinicia — no es a prueba de balas,
solo frena abuso trivial y scripts:

- **HTTP `/api/*`**: máximo 40 peticiones/10s por IP (`req.ip`, con
  `trust proxy` activo porque el despliegue va detrás de Apache). Por
  encima, `429`.
- **Login**: tras 5 fallos por IP en 5 minutos, `429` aunque las
  credenciales sean correctas; se resetea al acertar o al caducar la
  ventana. Independiente del límite general de `/api/*`.
- **`submitWord`**: más de 20 palabras/segundo por jugador (`socket.id`) y
  el servidor deja de validarlas — responde `wordResult` con
  `reason: 'throttled'`, sin procesar diccionario ni duplicados.
- **Eventos de socket en general**: más de 60 eventos/segundo de cualquier
  tipo desde un mismo socket lo desconecta (`socket.disconnect(true)`);
  ningún jugador humano se acerca a esa cifra.
- Los cuatro limitadores se barren cada 5 minutos (`sweep()`) para no
  acumular claves de sockets/IPs que ya no están.

## Tests

- **Unitarios** (`__tests__/game-logic.test.js`, `words.test.js`,
  `rate-limit.test.js`): lógica pura de `lib/`, sin sockets ni servidor.
- **Integración** (`__tests__/integration/`): arrancan el servidor real
  (`server.js` exporta `{ app, server, io, rooms, startServer, stopServer,
  validWordsCache, spawnBonus }` para esto) contra una base de datos de test
  aislada — `palabrejo_test_db`, nunca `palabrejo_db` — y hablan con él por
  HTTP/sockets con `socket.io-client`. Cubren: crear/unir/rechazar salas,
  partida completa (modos normal/exclusivo, puntos), reconexión con token,
  bonus (consumo, robo, expiración) y persistencia en BD al terminar.
- `server.js` no arranca solo al ser `require`ido (solo con
  `node server.js`, vía `require.main === module`): los tests llaman a
  `startServer()`/`stopServer()` ellos mismos, con `PORT=0` (puerto libre) y
  `DB_NAME=palabrejo_test_db` fijados *antes* del `require`.
- Al escribir un test que espera dos eventos que el servidor manda seguidos
  sin `await` entre medias (p.ej. `playerToken` y luego `roomStateUpdate`),
  hay que registrar **ambos** listeners antes de emitir la acción
  (`emitAndWait` en `testServer.js`) — si se espera uno con `await` y
  luego se registra el otro, el segundo puede haber llegado ya y perderse.
- Los clientes de test se conectan con `reconnection: false`: si no,
  cuando el servidor cierra al terminar (`stopServer`), el cliente intenta
  reconectar solo y dejar temporizadores vivos, y Jest no termina el
  proceso limpio.
- `npm test` corre las dos suites en un mismo comando. Necesitan una
  MariaDB accesible (`DB_HOST`, publicado en `3306` si se corre desde fuera
  del contenedor) — no se mockea la base de datos.
- La imagen de producción no lleva ni tests ni `devDependencies`
  (`jest`, `socket.io-client`): hay `.dockerignore` para que `COPY . .` en
  el `Dockerfile` no arrastre un `node_modules` de desarrollo del host.

## Sesiones y autenticación

- Login devuelve un token firmado (HMAC-SHA256) que el cliente reenvía al
  entrar en una sala. El servidor **nunca** se fía del `userId`/nombre que
  manda el cliente: los resuelve él mismo (`resolvePlayer`/`verifySession`)
  a partir del token.
- Sin caducidad por defecto (`SESSION_TTL_DAYS=0`); revocable por
  `token_version` (cambiar contraseña invalida sesiones abiertas).
- El secreto de firma se genera al primer arranque y se persiste en
  `app_settings` (sobrevive a reconstruir el contenedor), o se fija por
  entorno con `SESSION_SECRET`.
- Nombres de invitado: no pueden coincidir con una cuenta registrada
  (`isNameRegistered`).

## Amigos y estadísticas

- Solo cuentas registradas (invitados no tienen perfil ni amigos).
- Al terminar una partida se persiste en `games`/`game_players` y se
  actualiza `user_stats` (partidas, victorias, palabras, mejor puntuación)
  solo para jugadores con `userId`.

## Protocolo de sockets (eventos principales)

Cliente → servidor: `createRoom`, `joinRoom`, `rejoinGame`, `leaveRoom`,
`startGame`, `submitWord`, `endRoundManual`, `roundTimeout`,
`getPublicRooms`.

Servidor → cliente: `playerToken`, `roomStateUpdate`, `publicRoomsList`,
`roundStart`, `wordResult`, `palabrejo`, `letterBonus`,
`letterBonusExpired`, `bonusStolen`, `roundEnd`, `roundMissedWords`,
`restStart`, `gameOver`, `sessionExpired`, `error`.

Si cambias el payload de alguno de estos eventos, actualiza servidor y
cliente **en el mismo PR** (no hay versión de protocolo, van acoplados).

## Referencias

- Convenciones de código y flujo de trabajo: [AGENTS.md](../AGENTS.md).
- Cómo jugar y desplegar: [README.md](../README.md).
