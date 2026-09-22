// --- IMPORTS ---
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require("socket.io");
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const baseDbConfig = require('./config');
const { createLimiter } = require('./lib/rate-limit');

// Override por entorno (solo para tests de integracion, issue #8): apuntar a
// una base de datos distinta sin tocar config.js ni arriesgar la de produccion.
const dbConfig = {
    host: process.env.DB_HOST || baseDbConfig.host,
    user: process.env.DB_USER || baseDbConfig.user,
    password: process.env.DB_PASSWORD || baseDbConfig.password,
    database: process.env.DB_NAME || baseDbConfig.database
};

// --- SETUP ---
const app = express();
const PORT_HTTP = process.env.PORT || 3000;
const PORT_HTTPS = 3001;

let dbPool;

// Detrás de Apache (mod_proxy) en despliegue: sin esto req.ip seria siempre
// la IP del proxy y el rate-limit por IP agruparia a todo el mundo.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static('public'));

// --- RATE LIMIT (issue #3) ---
// En memoria, sin dependencias: el server es single-process. No es a prueba
// de balas (reinicia con el proceso) pero frena abuso trivial y scripts.
const apiLimiter = createLimiter({ windowMs: 10 * 1000 });
const API_LIMIT_PER_WINDOW = 40;
const loginFailLimiter = createLimiter({ windowMs: 5 * 60 * 1000 });
const LOGIN_FAIL_LIMIT = 5;

app.use('/api/', (req, res, next) => {
    if (apiLimiter.hit(req.ip) > API_LIMIT_PER_WINDOW) {
        return res.status(429).json({ error: 'Demasiadas peticiones. Prueba de nuevo en unos segundos.' });
    }
    next();
});

// --- SSL ---
// Los tests de integracion necesitan HTTP simple y un puerto libre (PORT=0):
// en una maquina que tenga certificados en /ssl/keys (como este server) sin
// FORCE_HTTP el arranque se iria a HTTPS:3001 y romperia toda la suite.
// En produccion nadie define FORCE_HTTP y el comportamiento no cambia.
const forceHttp = process.env.FORCE_HTTP === '1';
const sslKeyPath = '/ssl/keys/key.pem';
const sslCertPath = '/ssl/keys/certs.pem';
let server;
let io;

if (!forceHttp && fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
    try {
        const httpsOptions = {
            key: fs.readFileSync(sslKeyPath),
            cert: fs.readFileSync(sslCertPath)
        };
        server = https.createServer(httpsOptions, app);
        io = new Server(server);
    } catch (error) {
        console.error("SSL error, falling back to HTTP.", error);
        server = http.createServer(app);
        io = new Server(server);
    }
} else {
    server = http.createServer(app);
    io = new Server(server);
}

// --- GAME LOGIC (pure functions and constants, unit-testable) ---
const {
    LETTER_POOL, MIN_LETTERS, MAX_LETTERS, DEFAULT_ROUNDS, DEFAULT_MAX_PLAYERS,
    MIN_WORD_LENGTH, DEFAULT_ROUND_TIME, NEXT_GAME_DELAY_MS, MIN_VOWELS, VOWELS,
    MIN_PLAYABLE_WORDS, MAX_LETTER_ROLL_ATTEMPTS, PALABREJO_BONUS,
    DEFAULT_GAME_MODE, normalizeGameMode,
    calculateScore,
    isPalabrejo,
    normalizeForMatch,
    sanitizeGuestName,
    generateLetters: _generateLetters,
    countPlayableWords: _countPlayableWords,
    getPlayableWords,
    selectPlayableLetters: _selectPlayableLetters,
    isWordValid: _isWordValid,
    buildWordsByDistinctCount,
    BONUS_MIN_SPAWN_DELAY_MS, BONUS_MAX_SPAWN_DELAY_MS,
    BONUS_MIN_DURATION_MS, BONUS_MAX_DURATION_MS,
    rollBonus,
    applyBonus
} = require('./lib/game-logic');

// --- IN-MEMORY STORAGE ---
let rooms = {};

// --- VALID WORDS CACHE ---
let validWordsCache = new Set();
let validWordsCanonical = new Set();
let validWordsByLength = {};
// Palabras agrupadas por su numero de letras distintas (6..8): de ahi se
// sacan los repartos de letras, para garantizar que siempre hay un PALABREJO.
let wordsByDistinctCount = {};

async function loadValidWords() {
    try {
        const [rows] = await dbPool.query('SELECT word, length FROM words');
        validWordsCache.clear();
        validWordsCanonical.clear();
        validWordsByLength = {};
        for (const row of rows) {
            validWordsCache.add(row.word.toLowerCase());
            validWordsCanonical.add(normalizeForMatch(row.word));
            if (!validWordsByLength[row.length]) validWordsByLength[row.length] = new Set();
            validWordsByLength[row.length].add(row.word.toLowerCase());
        }
        wordsByDistinctCount = buildWordsByDistinctCount(validWordsCache);
        console.log(`Loaded ${validWordsCache.size} valid words into cache.`);
    } catch (error) {
        console.error("Error loading valid words:", error);
    }
}

// --- SESIONES FIRMADAS ---
// Logica movida a src/session.js (issue #7, pasada 2): la usan tanto las
// rutas HTTP como los handlers de socket, asi que no encaja como "solo ruta".
const { createSessionModule } = require('./src/session');
const { loadSessionSecret, signSession, verifySession, isNameRegistered } =
    createSessionModule({ getDbPool: () => dbPool });

// --- MIGRATION LOGIC ---
function createDbPool(extra = {}) {
    return mysql.createPool({
        ...dbConfig,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 10000,
        ...extra
    });
}

// multipleStatements SOLO en esta conexion: los ficheros de migracion traen
// varias sentencias SQL seguidas. El pool que usa el resto de la app
// (dbPool) no lo activa (issue #7): con parametros (?) en todas las queries
// no hace falta, y no vale la pena el riesgo de dejarlo abierto en el pool
// entero por una necesidad puntual de arranque.
async function runDatabaseMigrations() {
    console.log("Checking for database migrations...");
    const migrationPool = createDbPool({ connectionLimit: 2, multipleStatements: true });
    let connection;
    try {
        connection = await migrationPool.getConnection();

        await connection.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version VARCHAR(255) PRIMARY KEY
            );
        `);

        const [runMigrationsRows] = await connection.query('SELECT version FROM schema_migrations');
        const runMigrations = runMigrationsRows.map(row => row.version);

        const migrationFiles = (await fsp.readdir(path.join(__dirname, 'migrations')))
            .filter(file => file.endsWith('.sql'))
            .sort();

        const migrationsToRun = migrationFiles.filter(file => !runMigrations.includes(file));

        if (migrationsToRun.length === 0) {
            console.log("Database is already up to date.");
        } else {
            console.log(`Found ${migrationsToRun.length} new migrations to run.`);
            for (const file of migrationsToRun) {
                console.log(` - Running migration: ${file}`);
                const sql = await fsp.readFile(path.join(__dirname, 'migrations', file), 'utf-8');
                await connection.query(sql);
                await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
                console.log(`   ... ${file} finished and recorded.`);
            }
            console.log("All new migrations completed successfully.");
        }
        connection.release();
    } catch (error) {
        console.error("!!! FATAL MIGRATION ERROR !!!");
        console.error(error);
        if (connection) connection.release();
        process.exit(1);
    } finally {
        await migrationPool.end();
    }

    dbPool = createDbPool();
}

// --- RUTAS HTTP ---
// auth, perfil, amigos y leaderboard viven en src/routes/ (issue #7, pasada 2)
const { registerAuthRoutes } = require('./src/routes/auth');
const { registerProfileRoutes } = require('./src/routes/profile');
const { registerFriendsRoutes } = require('./src/routes/friends');
const { registerLeaderboardRoutes } = require('./src/routes/leaderboard');
const { registerQrRoutes } = require('./src/routes/qr');

registerAuthRoutes(app, { getDbPool: () => dbPool, bcrypt, signSession, verifySession, isNameRegistered, loginFailLimiter, LOGIN_FAIL_LIMIT });
registerProfileRoutes(app, { getDbPool: () => dbPool });
registerFriendsRoutes(app, { getDbPool: () => dbPool, verifySession });
registerLeaderboardRoutes(app, { getDbPool: () => dbPool });
registerQrRoutes(app);

// --- WRAPPERS (certifican el diccionario en memoria) ---
// generateLetters, normalizeForMatch y calculateScore se usan tal cual desde
// lib/game-logic.js; las de abajo le adjuntan el diccionario cargado.

function generateLetters(count) {
    return _generateLetters(count);
}

function isWordValid(word, letters) {
    return _isWordValid(word, letters, { validWordsCanonical });
}

function countPlayableWords(letters) {
    return _countPlayableWords(letters, { validWordsCanonical });
}

function selectPlayableLetters(count) {
    return _selectPlayableLetters(count, { validWordsCanonical, wordsByDistinctCount });
}

// Identidad de confianza para los eventos de socket. El nombre se lee de la
// base de datos, no del cliente: asi un token valido tampoco permite jugar con
// el nombre de otro.
async function resolveIdentity(sessionToken) {
    if (!sessionToken) return { userId: null, username: null, invalid: false };
    const session = await verifySession(sessionToken);
    if (!session) return { userId: null, username: null, invalid: true };
    return { userId: session.userId, username: session.username, invalid: false };
}

// Evento propio (no un 'error' generico) para que el cliente sepa que debe
// olvidar la sesion guardada y volver a la pantalla de acceso
function emitSessionExpired(socket) {
    socket.emit('sessionExpired', 'Tu sesión ha caducado. Vuelve a iniciar sesión.');
}

// Identidad final para entrar a una sala: {name, userId} o {error}
async function resolvePlayer(sessionToken, playerName) {
    const identity = await resolveIdentity(sessionToken);
    if (identity.invalid) return { expired: true };
    if (identity.userId) return { name: identity.username, userId: identity.userId };

    const name = sanitizeGuestName(playerName);
    if (await isNameRegistered(name)) {
        return { error: 'Ese nombre pertenece a una cuenta registrada. Inicia sesión o elige otro.' };
    }
    return { name, userId: null };
}

// --- JUEGO Y SOCKETS ---
// Logica de salas/rondas/bonus (src/game) y registro de eventos de socket
// (src/socket): issue #7, pasada 3.
const { createGameModule } = require('./src/game/rooms');
const { registerSocketHandlers } = require('./src/socket/handlers');

// Frena a un cliente (o script) que dispara eventos de socket sin parar: por
// encima de esto ya no es un jugador humano tecleando/tocando.
const socketFloodLimiter = createLimiter({ windowMs: 1000 });
const SOCKET_EVENTS_PER_SECOND = 60;
const wordSubmitLimiter = createLimiter({ windowMs: 1000 });
const WORD_SUBMIT_LIMIT_PER_SECOND = 20;

const game = createGameModule({
    io,
    rooms,
    getDbPool: () => dbPool,
    gameLogic: {
        calculateScore, isPalabrejo, normalizeForMatch, getPlayableWords,
        selectPlayableLetters, MIN_LETTERS, MAX_LETTERS, DEFAULT_GAME_MODE,
        NEXT_GAME_DELAY_MS, PALABREJO_BONUS,
        BONUS_MIN_SPAWN_DELAY_MS, BONUS_MAX_SPAWN_DELAY_MS,
        BONUS_MIN_DURATION_MS, BONUS_MAX_DURATION_MS,
        rollBonus, validWordsCache
    }
});

registerSocketHandlers({
    io, rooms, game, crypto,
    resolvePlayer, emitSessionExpired,
    normalizeForMatch, isWordValid, calculateScore, isPalabrejo, applyBonus,
    PALABREJO_BONUS, MIN_WORD_LENGTH, DEFAULT_MAX_PLAYERS, DEFAULT_ROUNDS,
    DEFAULT_ROUND_TIME, normalizeGameMode,
    socketFloodLimiter, SOCKET_EVENTS_PER_SECOND,
    wordSubmitLimiter, WORD_SUBMIT_LIMIT_PER_SECOND
});

// --- SERVER INIT ---
let sweepInterval = null;
let roomSweepInterval = null;

// El mantenimiento de salas (issue #15) corre mas menudo que el barrido de
// limitadores: detectar y sacar una sala waiting huerfana en 1 min en vez de 5.
const ROOM_HEALTH_INTERVAL_MS = 60 * 1000;

// Devuelve una promesa que resuelve cuando ya esta escuchando (no al
// disparar el listen): los tests de integracion necesitan saber cuando el
// servidor esta listo, y de paso permite PORT=0 (puerto libre asignado por
// el SO) sin adivinar cual toco.
async function startServer() {
    await runDatabaseMigrations();
    await loadSessionSecret();
    await loadValidWords();

    const activePort = server instanceof https.Server ? PORT_HTTPS : PORT_HTTP;
    const protocol = server instanceof https.Server ? 'https' : 'http';

    await new Promise(resolve => {
        server.listen(activePort, () => {
            console.log(`\nPalabrejo running on ${protocol}://localhost:${server.address().port}`);
            console.log("Ready to accept connections.");
            resolve();
        });
    });

    // Los limitadores acumulan una clave por IP/socket visto: sin esto
    // crecerian sin fin en un proceso que lleva dias arriba.
    sweepInterval = setInterval(() => {
        apiLimiter.sweep();
        loginFailLimiter.sweep();
        socketFloodLimiter.sweep();
        wordSubmitLimiter.sweep();
    }, 5 * 60 * 1000);
    sweepInterval.unref?.();

    // Salud de salas: cierra waiting huerfanas y avisa a los durmientes.
    roomSweepInterval = setInterval(() => game.sweepRooms(), ROOM_HEALTH_INTERVAL_MS);
    roomSweepInterval.unref?.();
}

// Contrapartida de startServer para los tests de integracion (issue #8):
// cierra sockets, timers de sala y el pool de BD para que el proceso de test
// termine limpio, sin conexiones ni salas colgadas.
async function stopServer() {
    if (sweepInterval) { clearInterval(sweepInterval); sweepInterval = null; }
    if (roomSweepInterval) { clearInterval(roomSweepInterval); roomSweepInterval = null; }
    for (const roomCode of Object.keys(rooms)) {
        const room = rooms[roomCode];
        if (room.roundTimer) clearTimeout(room.roundTimer);
        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
        if (room.restTimer) clearTimeout(room.restTimer);
        if (room.hostRequestTimer) clearTimeout(room.hostRequestTimer);
        game.clearBonusTimers(room);
        delete rooms[roomCode];
    }
    await new Promise(resolve => io.close(resolve));
    if (dbPool) await dbPool.end();
}

module.exports = { app, server, io, rooms, startServer, stopServer, validWordsCache, spawnBonus: game.spawnBonus, sweepRooms: game.sweepRooms };

// En produccion (`node server.js`, o `CMD` del Dockerfile) arranca solo. Al
// requerirse como modulo desde un test, quien lo requiere decide cuando
// arrancar y con que configuracion (puerto/BD) via variables de entorno.
if (require.main === module) {
    startServer();
}
