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
const sslKeyPath = '/ssl/keys/key.pem';
const sslCertPath = '/ssl/keys/certs.pem';
let server;
let io;

if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
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

registerAuthRoutes(app, { getDbPool: () => dbPool, bcrypt, signSession, verifySession, isNameRegistered, loginFailLimiter, LOGIN_FAIL_LIMIT });
registerProfileRoutes(app, { getDbPool: () => dbPool });
registerFriendsRoutes(app, { getDbPool: () => dbPool, verifySession });
registerLeaderboardRoutes(app, { getDbPool: () => dbPool });

// --- HELPER FUNCTIONS ---
function generateRoomCode() {
    let code;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    do {
        code = '';
        for (let i = 0; i < 4; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (rooms[code]);
    return code;
}

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

function getRoomStateForClient(room) {
    return {
        code: room.code,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            wordsFound: p.wordsFound,
            isHost: p.isHost,
            isGuest: p.isGuest,
            wordsThisRound: Array.from(p.wordsThisRound || []),
            roundScore: Array.from(p.wordsThisRound || []).reduce((sum, w) => sum + (p.wordPoints?.[w] ?? calculateScore(w, room.currentLetters)), 0)
        })),
        gameState: room.gameState,
        hostId: room.hostId,
        config: {
            maxPlayers: room.maxPlayers,
            totalRounds: room.totalRounds,
            roundTime: room.roundTime,
            isPublic: room.isPublic,
            gameMode: room.gameMode || DEFAULT_GAME_MODE,
            bonusesEnabled: room.bonusesEnabled !== false
        },
        currentRound: room.currentRound,
        totalRounds: room.totalRounds,
        letters: room.currentLetters
    };
}

function getPublicRooms() {
    return Object.values(rooms)
        .filter(room => room.isPublic && room.gameState === 'waiting')
        .map(room => ({
            code: room.code,
            playerCount: room.players.length,
            maxPlayers: room.maxPlayers,
            gameMode: room.gameMode || DEFAULT_GAME_MODE,
            players: room.players.map(p => p.name)
        }));
}

function broadcastPublicRooms() {
    io.emit('publicRoomsList', getPublicRooms());
}

function broadcastRoomState(roomCode) {
    io.to(roomCode).emit('roomStateUpdate', getRoomStateForClient(rooms[roomCode]));
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

// Saca al socket de cualquier sala en la que este. Un socket solo puede
// pertenecer a una sala: si se queda en dos, findRoomBySocket devuelve la
// primera que encuentra y las acciones acaban aplicandose a la sala
// equivocada (empezar la partida, enviar palabras, etc.).
// Semantica de "me voy": el jugador se elimina, al contrario que en una
// desconexion, donde se le guarda el sitio un rato por si vuelve.
function detachSocketFromRooms(socket) {
    for (const [roomCode, room] of Object.entries(rooms)) {
        if (!room.players.some(p => p.id === socket.id)) continue;

        socket.leave(roomCode);
        const wasHost = room.hostId === socket.id;
        room.players = room.players.filter(p => p.id !== socket.id);

        if (room.players.length === 0) {
            if (room.roundTimer) clearTimeout(room.roundTimer);
            if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
            if (room.restTimer) clearTimeout(room.restTimer);
            clearBonusTimers(room);
            delete rooms[roomCode];
            if (room.isPublic) broadcastPublicRooms();
            continue;
        }

        if (wasHost) {
            room.hostId = room.players[0].id;
            room.players[0].isHost = true;
        }
        broadcastRoomState(roomCode);
        if (room.isPublic) broadcastPublicRooms();
    }
}

// --- SOCKET.IO ---
// Frena a un cliente (o script) que dispara eventos de socket sin parar: por
// encima de esto ya no es un jugador humano tecleando/tocando.
const socketFloodLimiter = createLimiter({ windowMs: 1000 });
const SOCKET_EVENTS_PER_SECOND = 60;
const wordSubmitLimiter = createLimiter({ windowMs: 1000 });
const WORD_SUBMIT_LIMIT_PER_SECOND = 20;

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.onAny(() => {
        if (socketFloodLimiter.hit(socket.id) > SOCKET_EVENTS_PER_SECOND) {
            socket.disconnect(true);
        }
    });

    socket.on('createRoom', async ({ playerName, isPublic, maxPlayers, totalRounds, roundTime, gameMode, bonusesEnabled, sessionToken }) => {
        const player = await resolvePlayer(sessionToken, playerName);
        if (player.expired) return emitSessionExpired(socket);
        if (player.error) return socket.emit('error', player.error);

        detachSocketFromRooms(socket);

        const roomCode = generateRoomCode();
        const clampedMax = Math.min(Math.max(maxPlayers || DEFAULT_MAX_PLAYERS, 2), 12);
        const clampedRounds = Math.min(Math.max(totalRounds || DEFAULT_ROUNDS, 1), 15);
        const clampedTime = Math.min(Math.max(roundTime || DEFAULT_ROUND_TIME, 30), 180);
        const mode = normalizeGameMode(gameMode);

        rooms[roomCode] = {
            code: roomCode,
            players: [],
            gameState: 'waiting',
            hostId: socket.id,
            isPublic: isPublic !== false,
            maxPlayers: clampedMax,
            totalRounds: clampedRounds,
            roundTime: clampedTime,
            gameMode: mode,
            bonusesEnabled: bonusesEnabled !== false,
            currentRound: 0,
            currentLetters: [],
            roundTimer: null,
            roundEndsAt: 0,
            roundEnded: false,
            usedWords: {},
            cleanupTimer: null,
            restTimer: null,
            restEndsAt: 0,
            activeBonus: null,
            bonusSpawnTimer: null,
            bonusExpireTimer: null
        };

        const token = crypto.randomBytes(16).toString('hex');
        addPlayerToRoom(roomCode, socket.id, player.name, true, !player.userId, player.userId, token);
        socket.join(roomCode);
        socket.emit('playerToken', { roomCode, token });

        broadcastRoomState(roomCode);
        if (rooms[roomCode].isPublic) broadcastPublicRooms();
    });

    // El cliente avisa al volver al hall, en lugar de dejar el socket dentro
    socket.on('leaveRoom', () => {
        detachSocketFromRooms(socket);
    });

    socket.on('getPublicRooms', () => {
        socket.emit('publicRoomsList', getPublicRooms());
    });

    socket.on('joinRoom', async ({ roomCode, playerName, sessionToken }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'La sala no existe.');
        if (room.gameState !== 'waiting') return socket.emit('error', 'La partida ya ha comenzado.');
        if (room.players.length >= room.maxPlayers) return socket.emit('error', 'La sala está llena.');

        const player = await resolvePlayer(sessionToken, playerName);
        if (player.expired) return emitSessionExpired(socket);
        if (player.error) return socket.emit('error', player.error);

        detachSocketFromRooms(socket);

        const token = crypto.randomBytes(16).toString('hex');
        addPlayerToRoom(roomCode, socket.id, player.name, false, !player.userId, player.userId, token);
        socket.join(roomCode);
        socket.emit('playerToken', { roomCode, token });

        broadcastRoomState(roomCode);
        if (room.isPublic) broadcastPublicRooms();
    });

    // A player whose connection dropped can rejoin their in-progress game with
    // the token given at join time. The socket.id is swapped (reconnect gives a
    // new socket) and the round state is re-pushed so the UI resumes live.
    socket.on('rejoinGame', ({ roomCode, token }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'La sala ya no existe.');
        const player = room.players.find(p => p.resumeToken === token);
        if (!player) return socket.emit('error', 'No se pudo reanudar la sala.');

        // Cancel any pending room cleanup scheduled by the disconnect.
        if (room.cleanupTimer) {
            clearTimeout(room.cleanupTimer);
            room.cleanupTimer = null;
        }

        // If the old socket is still known (e.g. a duplicate tab), leave it.
        const oldSocketId = player.id;
        if (oldSocketId !== socket.id) {
            const oldPlayerIndex = room.players.findIndex(p => p.id === socket.id);
            if (oldPlayerIndex !== -1) room.players.splice(oldPlayerIndex, 1);
        }

        player.id = socket.id;
        player.disconnected = false;
        player.name = player.name.replace(/^\u274C /, '');
        socket.join(roomCode);

        // El socket.id cambia al reconectar: sin esto el host que vuelve
        // conservaba la insignia pero perdia sus permisos
        if (player.isHost) room.hostId = socket.id;

        if (room.gameState !== 'waiting' && room.gameState !== 'playing' && room.gameState !== 'rest') {
            socket.emit('error', 'La partida ya ha terminado.');
            return;
        }

        // El estado de la sala va PRIMERO: 'roundStart' se pinta contando con
        // que el cliente ya conoce la sala (rondas, jugadores, marcador).
        broadcastRoomState(roomCode);

        if (room.gameState === 'playing') {
            socket.emit('roundStart', {
                round: room.currentRound,
                totalRounds: room.totalRounds,
                letters: room.currentLetters,
                time: Math.max(1, Math.ceil((room.roundEndsAt - Date.now()) / 1000)),
                rejoined: true,
                // Palabras ya acertadas en esta ronda, para repoblar la lista
                words: Array.from(player.wordsThisRound).map(w => ({
                    word: w,
                    points: player.wordPoints?.[w] ?? calculateScore(w, room.currentLetters),
                    palabrejo: isPalabrejo(w, room.currentLetters)
                }))
            });
        }
        if (room.gameState === 'rest' && room.restTimer) {
            // Quien vuelve durante el descanso recupera la cuenta atras hacia
            // la siguiente partida, con el tiempo restante real.
            socket.emit('restStart', { delay: Math.max(1000, room.restEndsAt - Date.now()) });
        }
        if (room.isPublic) broadcastPublicRooms();
    });

    socket.on('startGame', () => {
        const roomCode = findRoomBySocket(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 1) return socket.emit('error', 'No hay jugadores en la sala.');

        // A single player can start too (modo solitario)
        room.gameState = 'playing';
        room.currentRound = 1;
        room.usedWords = {};
        room.players.forEach(p => { p.score = 0; p.totalWordsFound = 0; });

        startRound(roomCode);
    });

    socket.on('submitWord', (payload) => {
        // Lo que llega por el socket puede ser cualquier cosa: sin este filtro,
        // un cliente cualquiera tumba el servidor mandando algo que no sea texto
        const word = typeof payload?.word === 'string' ? payload.word : null;
        if (!word) return;

        const roomCode = findRoomBySocket(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const cleanWord = word.trim().toLowerCase();
        if (cleanWord.length < MIN_WORD_LENGTH) return;

        // Por encima de esto ya no es alguien jugando: se descarta sin
        // validar (ni contra diccionario ni contra duplicados) para no
        // regalar trabajo pesado a un cliente que abusa.
        if (wordSubmitLimiter.hit(socket.id) > WORD_SUBMIT_LIMIT_PER_SECOND) {
            return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'throttled', points: 0 });
        }

        // Words with/without accents are the same word for duplicate purposes
        // (ñ stays distinct). Words found are kept as typed for display.
        const wordKey = normalizeForMatch(cleanWord);
        if (player.wordsThisRound.has(wordKey)) {
            return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'duplicate', points: 0 });
        }

        if (!isWordValid(cleanWord, room.currentLetters)) {
            return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'invalid', points: 0 });
        }

        // En modo exclusivo la palabra se la queda quien la manda primero; en
        // el normal cada jugador va a lo suyo y todos pueden encontrarla.
        if (room.gameMode === 'exclusivo') {
            const roundKey = `${roomCode}_r${room.currentRound}`;
            if (!room.usedWords[roundKey]) room.usedWords[roundKey] = new Set();
            if (room.usedWords[roundKey].has(wordKey)) {
                return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'used_by_other', points: 0 });
            }
            room.usedWords[roundKey].add(wordKey);
        }
        player.wordsThisRound.add(wordKey);
        player.wordsFound.push(cleanWord);

        const palabrejo = isPalabrejo(cleanWord, room.currentLetters);
        const basePoints = calculateScore(cleanWord, room.currentLetters);

        // Si la palabra usa la letra con bonus/castigo activo, se consume
        // aqui: solo el primero en jugarla se lleva el efecto.
        let points = basePoints;
        let bonusApplied = null;
        const bonus = room.activeBonus;
        if (bonus && normalizeForMatch(cleanWord).includes(normalizeForMatch(bonus.letter))) {
            points = applyBonus(basePoints, bonus);
            bonusApplied = { letter: bonus.letter, kind: bonus.kind, value: bonus.value, malus: bonus.malus, label: bonus.label };

            if (room.bonusExpireTimer) { clearTimeout(room.bonusExpireTimer); room.bonusExpireTimer = null; }
            room.activeBonus = null;
            io.to(roomCode).emit('letterBonusExpired', { letter: bonus.letter, reason: 'used', playerName: player.name, kind: bonus.kind, label: bonus.label });
            scheduleBonusSpawn(roomCode);

            if (bonus.kind === 'steal') {
                const target = room.players
                    .filter(p => p.id !== player.id)
                    .sort((a, b) => b.score - a.score)[0];
                if (target) {
                    target.score = Math.max(0, target.score - bonus.value);
                    io.to(roomCode).emit('bonusStolen', { from: target.name, to: player.name, amount: bonus.value });
                }
            }
        }

        player.wordPoints[wordKey] = points;
        player.score += points;
        player.totalWordsFound++;

        socket.emit('wordResult', { word: cleanWord, valid: true, reason: 'ok', points, basePoints, palabrejo, bonusApplied });
        // El PALABREJO es la jugada de la ronda y se anuncia a la sala, pero
        // sin decir cual es: que cada cual la busque por su cuenta.
        if (palabrejo) {
            io.to(roomCode).emit('palabrejo', { playerName: player.name, bonus: PALABREJO_BONUS });
        }
        broadcastRoomState(roomCode);
    });

    socket.on('endRoundManual', () => {
        const roomCode = findRoomBySocket(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        endRound(roomCode);
    });

    // Safety net: when a player's countdown hits 0 the client asks the server
    // to end the round. The server timer is authoritative; this event only
    // helps if it did not fire (and it is restricted to the final 2 seconds).
    socket.on('roundTimeout', () => {
        const roomCode = findRoomBySocket(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'playing') return;
        if (Date.now() >= room.roundEndsAt - 2000) endRound(roomCode);
    });

    socket.on('disconnect', () => {
        const roomCode = findRoomBySocket(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (room.gameState === 'waiting') {
            // Antes de empezar no hay nada que guardar: se le saca de la sala
            detachSocketFromRooms(socket);
        } else if (room.gameState !== 'finished') {
            // In-progress game: keep the room alive for a grace period so a
            // transient connection drop (mobile wifi, etc.) does not kill the
            // whole match. The player can rejoin with their resume token.
            player.name = `❌ ${player.name}`;
            player.disconnected = true;
            broadcastRoomState(roomCode);
            scheduleRoomCleanup(roomCode);
        }
    });
});

// --- GAME LOGIC ---
function addPlayerToRoom(roomCode, playerId, playerName, isHost = false, isGuest = false, userId = null, resumeToken = null) {
    rooms[roomCode].players.push({
        id: playerId,
        name: playerName,
        score: 0,
        wordsFound: [],
        wordsThisRound: new Set(),
        wordPoints: {},
        totalWordsFound: 0,
        isHost,
        isGuest,
        userId,
        disconnected: false,
        resumeToken
    });
}

function findRoomBySocket(socketId) {
    for (const [code, room] of Object.entries(rooms)) {
        if (room.players.some(p => p.id === socketId)) return code;
    }
    return null;
}

// A dropped connection no longer deletes an in-progress room instantly:
// schedule a deletion only if nobody comes back within the grace period.
const RESUME_GRACE_MS = 2 * 60 * 1000;

function scheduleRoomCleanup(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => {
        room.cleanupTimer = null;
        const alive = room.players.some(p => !p.disconnected);
        if (!alive) {
            if (room.roundTimer) clearTimeout(room.roundTimer);
            clearBonusTimers(room);
            delete rooms[roomCode];
        }
    }, RESUME_GRACE_MS);
}

function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const letterCount = MIN_LETTERS + Math.floor(Math.random() * (MAX_LETTERS - MIN_LETTERS + 1));
    room.currentLetters = selectPlayableLetters(letterCount);
    room.roundEnded = false;
    room.roundEndsAt = Date.now() + room.roundTime * 1000;

    room.players.forEach(p => { p.wordsThisRound = new Set(); p.wordPoints = {}; });

    io.to(roomCode).emit('roundStart', {
        round: room.currentRound,
        totalRounds: room.totalRounds,
        letters: room.currentLetters,
        time: room.roundTime
    });
    broadcastRoomState(roomCode);

    room.roundTimer = setTimeout(() => endRound(roomCode), room.roundTime * 1000);

    clearBonusTimers(room);
    if (room.bonusesEnabled) scheduleBonusSpawn(roomCode);
}

// --- BONUS/CASTIGO EN EL TABLERO ---
function clearBonusTimers(room) {
    if (room.bonusSpawnTimer) { clearTimeout(room.bonusSpawnTimer); room.bonusSpawnTimer = null; }
    if (room.bonusExpireTimer) { clearTimeout(room.bonusExpireTimer); room.bonusExpireTimer = null; }
    room.activeBonus = null;
}

// De vez en cuando, mientras la ronda esta en marcha, aparece un bonus o
// castigo sobre una letra del tablero al azar. Solo hay uno activo a la vez;
// si nadie lo usa antes de que caduque, desaparece y se programa el
// siguiente.
function scheduleBonusSpawn(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing') return;

    const delay = randomBetween(BONUS_MIN_SPAWN_DELAY_MS, BONUS_MAX_SPAWN_DELAY_MS);
    const timeLeft = room.roundEndsAt - Date.now();
    if (timeLeft <= delay + BONUS_MIN_DURATION_MS) return; // no cabe otra ronda de bonus

    room.bonusSpawnTimer = setTimeout(() => spawnBonus(roomCode), delay);
}

function randomBetween(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function spawnBonus(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeBonus) return;
    if (!room.currentLetters || room.currentLetters.length === 0) return;

    const letter = room.currentLetters[Math.floor(Math.random() * room.currentLetters.length)];
    const bonus = rollBonus();
    const maxDuration = Math.max(BONUS_MIN_DURATION_MS, Math.min(BONUS_MAX_DURATION_MS, room.roundEndsAt - Date.now() - 1000));
    const duration = randomBetween(BONUS_MIN_DURATION_MS, maxDuration);

    room.activeBonus = { letter, ...bonus, expiresAt: Date.now() + duration };

    io.to(roomCode).emit('letterBonus', {
        letter,
        kind: bonus.kind,
        value: bonus.value,
        malus: bonus.malus,
        aggressive: bonus.aggressive,
        label: bonus.label,
        durationMs: duration
    });

    room.bonusExpireTimer = setTimeout(() => {
        const r = rooms[roomCode];
        if (!r || !r.activeBonus || r.activeBonus.letter !== letter) return;
        r.activeBonus = null;
        io.to(roomCode).emit('letterBonusExpired', { letter, reason: 'timeout' });
        scheduleBonusSpawn(roomCode);
    }, duration);
}

function endRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.roundEnded) return; // ignore double-triggers (timeout, manual spam)

    room.roundEnded = true;
    if (room.roundTimer) {
        clearTimeout(room.roundTimer);
        room.roundTimer = null;
    }
    clearBonusTimers(room);

    const roundResults = room.players.map(p => ({
        id: p.id,
        name: p.name,
        wordsThisRound: Array.from(p.wordsThisRound),
        scoreThisRound: Array.from(p.wordsThisRound).reduce((sum, w) => sum + (p.wordPoints?.[w] ?? calculateScore(w, room.currentLetters)), 0),
        totalScore: p.score
    }));

    // Las palabras mas largas de la ronda, encontradas por quien sea: un
    // vistazo rapido a la mejor jugada, sin tener que leer todas las listas.
    const foundTally = {};
    room.players.forEach(p => {
        p.wordsThisRound.forEach(w => {
            if (!foundTally[w]) foundTally[w] = { word: w, players: [] };
            foundTally[w].players.push(p.name);
        });
    });
    const topWords = Object.values(foundTally)
        .sort((a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word))
        .slice(0, 5);

    io.to(roomCode).emit('roundEnd', {
        round: room.currentRound,
        results: roundResults,
        letters: room.currentLetters,
        topWords
    });

    // Las que se le escaparon a cada uno: personal, solo para quien no las
    // encontro (no tiene gracia que el resto vea lo que a ti te faltó).
    const playable = getPlayableWords(room.currentLetters, { validWordsCache });
    room.players.forEach(p => {
        const missed = playable
            .filter(w => !p.wordsThisRound.has(normalizeForMatch(w)))
            .sort((a, b) => b.length - a.length || a.localeCompare(b))
            .slice(0, 8);
        io.to(p.id).emit('roundMissedWords', { round: room.currentRound, words: missed });
    });

    if (room.currentRound >= room.totalRounds) {
        endGame(roomCode);
    } else {
        room.currentRound++;
        setTimeout(() => startRound(roomCode), 5000);
    }
}

async function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.gameState = 'rest';

    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    const winner = sorted[0];

    // Las mas repetidas (por distintos jugadores o en distintas rondas) y las
    // mas largas de toda la partida, igual que al terminar una ronda pero
    // sumando todo el juego.
    const tally = {};
    room.players.forEach(p => {
        p.wordsFound.forEach(w => {
            const key = normalizeForMatch(w);
            if (!tally[key]) tally[key] = { word: w, count: 0, players: [] };
            tally[key].count++;
            tally[key].players.push(p.name);
        });
    });
    const allWords = Object.values(tally);
    const mostFound = allWords
        .filter(t => t.count > 1)
        .sort((a, b) => b.count - a.count || b.word.length - a.word.length)
        .slice(0, 5);
    const longestWords = [...allWords]
        .sort((a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word))
        .slice(0, 5);

    io.to(roomCode).emit('gameOver', {
        winner: { id: winner.id, name: winner.name, score: winner.score },
        players: sorted.map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            wordsFound: p.wordsFound
        })),
        mostFound,
        longestWords
    });

    // Persist to DB for registered users
    try {
        const [gameResult] = await dbPool.query(
            'INSERT INTO games (room_code, host_user_id, max_players, total_rounds, letters_used) VALUES (?, ?, ?, ?, ?)',
            [room.code, room.players.find(p => p.isHost)?.userId || null, room.maxPlayers, room.totalRounds, room.currentLetters.join('')]
        );
        const gameId = gameResult.insertId;

        for (const p of room.players) {
            if (p.userId) {
                await dbPool.query(
                    'INSERT INTO game_players (game_id, user_id, score, words_found) VALUES (?, ?, ?, ?)',
                    [gameId, p.userId, p.score, JSON.stringify(p.wordsFound)]
                );

                const isWinner = p.id === winner.id;
                await dbPool.query(`
                    INSERT INTO user_stats (user_id, games_played, games_won, total_words, total_score, best_score)
                    VALUES (?, 1, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        games_played = games_played + 1,
                        games_won = games_won + VALUES(games_won),
                        total_words = total_words + VALUES(total_words),
                        total_score = total_score + VALUES(total_score),
                        best_score = GREATEST(best_score, VALUES(best_score))
                `, [p.userId, isWinner ? 1 : 0, p.wordsFound.length, p.score, p.score]);
            }
        }
    } catch (error) {
        console.error("Error persisting game results:", error);
    }

    // Descanso y arranque automatico de una partida nueva con la misma gente
    // y las mismas condiciones, mientras queden jugadores en la sala.
    room.restEndsAt = Date.now() + NEXT_GAME_DELAY_MS;
    room.restTimer = setTimeout(() => startNewGame(roomCode), NEXT_GAME_DELAY_MS);

    io.to(roomCode).emit('restStart', {
        delay: NEXT_GAME_DELAY_MS,
        roundTime: room.roundTime,
        totalRounds: room.totalRounds
    });
}

// Arranca una partida nueva en la misma sala, con las mismas condiciones y los
// jugadores que sigan dentro tras el descanso. Vacia el marcador y las listas
// de palabras para que la partida empiece de cero.
function startNewGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.restTimer = null;
    room.restEndsAt = 0;

    // Si ya no queda nadie en sala durante el descanso, se cierra la partida.
    if (!room.players.some(p => !p.disconnected)) {
        if (room.roundTimer) clearTimeout(room.roundTimer);
        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
        delete rooms[roomCode];
        if (room.isPublic) broadcastPublicRooms();
        return;
    }

    room.gameState = 'playing';
    room.currentRound = 1;
    room.usedWords = {};
    room.players.forEach(p => {
        p.score = 0;
        p.totalWordsFound = 0;
        p.wordsFound = [];
        p.wordsThisRound = new Set();
        p.wordPoints = {};
    });

    startRound(roomCode);
}

// --- SERVER INIT ---
let sweepInterval = null;

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
}

// Contrapartida de startServer para los tests de integracion (issue #8):
// cierra sockets, timers de sala y el pool de BD para que el proceso de test
// termine limpio, sin conexiones ni salas colgadas.
async function stopServer() {
    if (sweepInterval) { clearInterval(sweepInterval); sweepInterval = null; }
    for (const roomCode of Object.keys(rooms)) {
        const room = rooms[roomCode];
        if (room.roundTimer) clearTimeout(room.roundTimer);
        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
        if (room.restTimer) clearTimeout(room.restTimer);
        clearBonusTimers(room);
        delete rooms[roomCode];
    }
    await new Promise(resolve => io.close(resolve));
    if (dbPool) await dbPool.end();
}

module.exports = { app, server, io, rooms, startServer, stopServer, validWordsCache, spawnBonus };

// En produccion (`node server.js`, o `CMD` del Dockerfile) arranca solo. Al
// requerirse como modulo desde un test, quien lo requiere decide cuando
// arrancar y con que configuracion (puerto/BD) via variables de entorno.
if (require.main === module) {
    startServer();
}
