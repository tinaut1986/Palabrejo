# Palabrero

Juego web multijugador y competitivo de formar palabras en español. Cada ronda
reparte un puñado de letras y todos los jugadores compiten, en tiempo real, por
formar con ellas las palabras más largas. Diseñado para jugarse **en el móvil**.

## Cómo se juega

- El anfitrión crea una sala (pública o privada) y comparte el código de 4
  letras o el QR.
- Cada ronda muestra un conjunto de letras. Formas palabras pulsando las
  teclas (o escribiendo, en escritorio) y las envías.
- Puntuación por longitud: 3 letras = 1 punto, 4 = 2, 5 = 4, 6 = 7, 7+ = 10.
- Mínimo 3 letras. Una palabra solo puntúa para el primer jugador que la envía
  en esa ronda.
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
docker build -t palabrero .
docker run -p 3000:3000 -v "$PWD/config.js:/app/config.js:ro" palabrero
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

## Configuración de sala

Ajustable por el anfitrión al crear la sala: 2–12 jugadores, 1–15 rondas y
30–180 segundos por ronda.

## Licencia

MIT — ver [LICENSE](LICENSE).
