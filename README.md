# Palabrejo

Juego web multijugador y competitivo de formar palabras en español. Cada ronda
reparte un puñado de letras y todos los jugadores compiten, en tiempo real, por
formar con ellas las palabras más largas. Diseñado para jugarse **en el móvil**.

## Cómo se juega

- El anfitrión crea una sala (pública o privada) y comparte el código de 4
  letras o el QR.
- Cada ronda muestra un conjunto de letras. Formas palabras pulsando las
  teclas (o escribiendo, en escritorio) y las envías.
- Puntuación por longitud: 3 letras = 1 punto, 4 = 2, 5 = 4, 6 = 7, 7+ = 10.
- **PALABREJO**: la palabra que usa *todas* las letras del tablero (pueden
  repetirse) vale **+15 puntos extra**. Cuando alguien encuentra uno se avisa a
  la sala, pero sin decir cuál es.
- Mínimo 3 letras. Nadie puede repetir una palabra suya dentro de la misma
  ronda.
- Dos modos, elegidos al crear la sala:
  - **Normal** (por defecto): varios jugadores pueden encontrar la misma
    palabra y a todos les puntúa.
  - **Exclusivo**: cada palabra puntúa solo para quien la envía primero.
- Al acabar todas las rondas gana quien más puntos acumule.

Las palabras se validan contra un diccionario de ~108.000 palabras del español
(RAE) almacenado en MariaDB/MySQL.

## Stack

- **Backend:** Node.js + Express 5 + Socket.IO
- **Base de datos:** MariaDB / MySQL (mysql2), migraciones automáticas al arrancar
- **Frontend:** HTML/CSS/JS sin framework, PWA instalable
- **Despliegue:** Docker

## Puesta en marcha

### Con Docker

```bash
cp config.example.js config.js   # ajusta host/usuario/password/base de datos
docker build -t palabrejo .
docker run -p 3000:3000 -v "$PWD/config.js:/app/config.js:ro" palabrejo
```

### En local

```bash
cp config.example.js config.js   # ajusta credenciales
npm install
./setup.sh                       # crea la base de datos y el usuario
npm start
```

El servidor escucha en el puerto `3000` (HTTP). Si existen los certificados en
`/ssl/keys/key.pem` y `/ssl/keys/certs.pem`, arranca en HTTPS en el `3001`.

Al arrancar se aplican las migraciones pendientes de `migrations/`, incluida
`001_seed_words.sql`, que carga el diccionario completo. No hace falta ningún
paso manual de importación.

## Diccionario

`migrations/001_seed_words.sql` contiene el diccionario ya listo para insertar
(idempotente, `INSERT IGNORE`). Para regenerarlo desde la fuente original:

```bash
python3 scripts/import_rae.py --download
```

La columna `word` usa collation `utf8mb4_bin` a propósito: con una collation
insensible a acentos, el índice `UNIQUE` consideraría `canto` y `cantó` la misma
palabra y se perderían unas 2.300 entradas válidas.

## Cuentas y sesiones

El login devuelve un token de sesión firmado (HMAC-SHA256) que el cliente
guarda y envía al entrar en una sala. **Por defecto no caduca**: se puede
poner un plazo con `SESSION_TTL_DAYS` (en días; `0` o sin definir = nunca). El servidor deriva de él la
identidad: **no se fía del `userId` ni del nombre que manda el cliente**, y para
un usuario registrado toma el nombre de la base de datos. Los nombres
registrados están reservados, así que un invitado no puede presentarse con el
nombre de una cuenta ajena.

El secreto de firma se genera al primer arranque y se guarda en `app_settings`,
de modo que las sesiones abiertas siguen valiendo tras reconstruir el
contenedor. Se puede fijar por entorno con `SESSION_SECRET`.

El token incluye un `token_version` que se contrasta con la base de datos, así
que las sesiones son revocables aunque la firma sea válida: al cambiar una
contraseña se incrementa y las sesiones abiertas de ese usuario mueren.

### Contraseña olvidada

No hay recuperación automática (el juego no pide email a nadie). La restablece
el administrador desde el servidor:

```bash
docker exec -it palabrejo_server node scripts/reset-password.js --list
docker exec -it palabrejo_server node scripts/reset-password.js <usuario>
docker exec -it palabrejo_server node scripts/reset-password.js <usuario> --random
```

Sin `--random` pide la contraseña por teclado, sin mostrarla. Con `--random`
genera una legible y la imprime, para dictarla. En ambos casos las sesiones
abiertas del usuario quedan invalidadas.

Como las sesiones no caducan solas, `--logout-all` las cierra sin cambiar la
contraseña — para echar a un dispositivo perdido:

```bash
docker exec -it palabrejo_server node scripts/reset-password.js <usuario> --logout-all
```

## Amigos

Los usuarios registrados pueden añadirse entre sí y comparar estadísticas
(puntos, victorias, mejor partida y media) en un ranking conjunto. Las
solicitudes se aceptan o rechazan desde el menú de amigos, y pedir amistad a
quien ya te la había pedido cuenta como aceptarla. Los invitados no tienen
perfil ni amigos: hace falta una cuenta.

El perfil de un jugador se abre pulsando su nombre, tanto el propio en el hall
como el de cualquier amigo en la lista.

## Desarrollo

Las mejoras se gestionan con **specs** versionadas en `docs/specs/` (una por
feature, con criterios de aceptación) y **issues de GitHub** que las referencian.
Todo el flujo de trabajo y las convenciones de código están en
[AGENTS.md](AGENTS.md) — léelo si vas a tocar el código (o eres un agente IA).

- Índice de specs con su estado: `docs/specs/README.md`.
- Plantilla para una spec nueva: `docs/specs/000_template.md`.

## Configuración de sala

Ajustable por el anfitrión al crear la sala: 2–12 jugadores, 1–15 rondas y
30–180 segundos por ronda.

## Licencia

MIT — ver [LICENSE](LICENSE).
