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
const dbConfig = require('./config');

// --- SETUP ---
const app = express();
const PORT_HTTP = process.env.PORT || 3000;
const PORT_HTTPS = 3001;

let dbPool;

app.use(express.json());
app.use(express.static('public'));

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

// --- LETTER POOL ---
// Weighted by frequency in Spanish
const LETTER_POOL = [
    'A','A','A','A','A','A','A','A',
    'B','B',
    'C','C','C',
    'D','D','D',
    'E','E','E','E','E','E','E','E','E','E',
    'F','F',
    'G','G',
    'H','H',
    'I','I','I','I','I','I','I',
    'J',
    'K',
    'L','L','L','L',
    'M','M','M',
    'N','N','N','N','N','N',
    'Ñ','Ñ',
    'O','O','O','O','O','O','O','O',
    'P','P','P',
    'Q',
    'R','R','R','R','R','R',
    'S','S','S','S','S','S','S',
    'T','T','T','T','T',
    'U','U','U','U',
    'V','V',
    'W',
    'X',
    'Y','Y',
    'Z'
];

// --- GAME CONSTANTS ---
const MIN_LETTERS = 6;
const MAX_LETTERS = 8;
const DEFAULT_ROUNDS = 5;
const DEFAULT_MAX_PLAYERS = 8;
const MIN_WORD_LENGTH = 3;
const DEFAULT_ROUND_TIME = 90;
const MIN_VOWELS = 2;
const VOWELS = ['A', 'E', 'I', 'O', 'U'];

// Scoring: longer words are worth exponentially more
function calculateScore(word) {
    const len = word.length;
    if (len === 3) return 1;
    if (len === 4) return 2;
    if (len === 5) return 4;
    if (len === 6) return 7;
    return 10; // 7+ letters
}

// --- IN-MEMORY STORAGE ---
let rooms = {};

// --- VALID WORDS CACHE ---
let validWordsCache = new Set();
let validWordsCanonical = new Set();
let validWordsByLength = {};

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
        console.log(`Loaded ${validWordsCache.size} valid words into cache.`);
    } catch (error) {
        console.error("Error loading valid words:", error);
    }
}

// --- MIGRATION LOGIC ---
async function runDatabaseMigrations() {
    console.log("Checking for database migrations...");
    let connection;
    try {
        dbPool = mysql.createPool({
            ...dbConfig,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 10000,
            multipleStatements: true
        });

        connection = await dbPool.getConnection();

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
            connection.release();
            return;
        }

        console.log(`Found ${migrationsToRun.length} new migrations to run.`);
        for (const file of migrationsToRun) {
            console.log(` - Running migration: ${file}`);
            const sql = await fsp.readFile(path.join(__dirname, 'migrations', file), 'utf-8');
            await connection.query(sql);
            await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
            console.log(`   ... ${file} finished and recorded.`);
        }

        console.log("All new migrations completed successfully.");
        connection.release();
    } catch (error) {
        console.error("!!! FATAL MIGRATION ERROR !!!");
        console.error(error);
        if (connection) connection.release();
        process.exit(1);
    }
}

// --- AUTH ENDPOINTS ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });
    }
    if (username.length < 2 || username.length > 20) {
        return res.status(400).json({ error: 'El nombre debe tener entre 2 y 20 caracteres.' });
    }
    if (password.length < 4) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
    }
    if (!/^[a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ_]+$/.test(username)) {
        return res.status(400).json({ error: 'El nombre solo puede contener letras, números y guiones bajos.' });
    }

    try {
        const [existing] = await dbPool.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Ese nombre de usuario ya está registrado.' });
        }

        const hash = await bcrypt.hash(password, 10);
        const [result] = await dbPool.query('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
        await dbPool.query('INSERT INTO user_stats (user_id) VALUES (?)', [result.insertId]);

        res.status(201).json({ message: 'Registro exitoso.', userId: result.insertId, username });
    } catch (error) {
        console.error("Register error:", error);
        res.status(500).json({ error: 'Error del servidor.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });
    }

    try {
        const [rows] = await dbPool.query('SELECT id, username, password_hash FROM users WHERE username = ?', [username]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        }

        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        }

        res.json({ message: 'Login exitoso.', userId: user.id, username: user.username });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ error: 'Error del servidor.' });
    }
});

app.get('/api/profile/:username', async (req, res) => {
    try {
        const [rows] = await dbPool.query(`
            SELECT u.username, u.created_at,
                   us.games_played, us.games_won, us.total_words,
                   us.total_score, us.best_score, us.favorite_words
            FROM users u
            LEFT JOIN user_stats us ON u.id = us.user_id
            WHERE u.username = ?
        `, [req.params.username]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado.' });
        }

        const profile = rows[0];
        const avgScore = profile.games_played > 0
            ? (profile.total_score / profile.games_played).toFixed(1)
            : 0;

        res.json({
            username: profile.username,
            created_at: profile.created_at,
            games_played: profile.games_played || 0,
            games_won: profile.games_won || 0,
            total_words: profile.total_words || 0,
            total_score: profile.total_score || 0,
            best_score: profile.best_score || 0,
            avg_score: parseFloat(avgScore),
            favorite_words: profile.favorite_words || []
        });
    } catch (error) {
        console.error("Profile error:", error);
        res.status(500).json({ error: 'Error del servidor.' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const [rows] = await dbPool.query(`
            SELECT u.username,
                   us.games_played, us.games_won, us.total_words,
                   us.total_score, us.best_score
            FROM users u
            JOIN user_stats us ON u.id = us.user_id
            WHERE us.games_played > 0
            ORDER BY us.total_score DESC
            LIMIT 50
        `);
        res.json(rows);
    } catch (error) {
        console.error("Leaderboard error:", error);
        res.status(500).json({ error: 'Error del servidor.' });
    }
});

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

// Generate `count` DISTINCT letters (each letter appears once on the rack and
// can be used as many times as the player wants). At least MIN_VOWELS vowels.
function generateLetters(count) {
    const letters = [];
    const used = new Set();
    const pool = [...LETTER_POOL];
    let guard = 0;
    while (letters.length < count && guard < 500) {
        guard++;
        const idx = Math.floor(Math.random() * pool.length);
        const l = pool[idx];
        if (!used.has(l)) {
            used.add(l);
            letters.push(l);
        }
    }
    // Fill any remaining slots from the distinct letters not already picked
    const remaining = Array.from(new Set(LETTER_POOL)).filter(l => !used.has(l));
    while (letters.length < count && remaining.length) {
        const i = Math.floor(Math.random() * remaining.length);
        const l = remaining.splice(i, 1)[0];
        used.add(l);
        letters.push(l);
    }
    // Guarantee at least MIN_VOWELS vowels, swapping consonants when needed
    const vowelSet = new Set(VOWELS);
    let vowels = letters.filter(l => vowelSet.has(l)).length;
    const shuffledVowels = [...VOWELS].sort(() => Math.random() - 0.5);
    let vi = 0;
    for (let i = 0; i < letters.length && vowels < MIN_VOWELS; i++) {
        if (vowelSet.has(letters[i])) continue;
        const cand = shuffledVowels[vi++ % shuffledVowels.length];
        if (!used.has(cand)) {
            used.delete(letters[i]);
            letters[i] = cand;
            used.add(cand);
            vowels++;
        }
    }
    return letters;
}

// Canonical form for comparisons: accents/marks are stripped but Ñ is kept as a
// distinct letter (e.g. "café" -> "cafe", "moño" -> "moño", "Ñoño" -> "ñoño").
// This is what lets words with/without accents be treated as the same word
// while ñ vs n remain different words.
function normalizeForMatch(str) {
    return str.normalize('NFD')
        .replace(/n\u0303/gi, 'ñ')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function isWordValid(word, letters) {
    const wordLower = word.toLowerCase();
    if (wordLower.length < MIN_WORD_LENGTH) return false;

    // Dict lookup uses the canonical form: words with/without accents are the
    // same word; ñ stays distinct from n.
    const canonical = normalizeForMatch(wordLower);
    if (!validWordsCanonical.has(canonical)) return false;

    // The word's letters (canonical, accent-free, ñ kept) must be a subset of
    // the rack letters. Each rack letter appears once but can be reused freely.
    const letterSet = new Set(letters.map(l => normalizeForMatch(l)));
    for (const c of canonical) {
        if (!letterSet.has(c)) return false;
    }
    return true;
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
            roundScore: Array.from(p.wordsThisRound || []).reduce((sum, w) => sum + calculateScore(w), 0)
        })),
        gameState: room.gameState,
        hostId: room.hostId,
        config: {
            maxPlayers: room.maxPlayers,
            totalRounds: room.totalRounds,
            roundTime: room.roundTime,
            isPublic: room.isPublic
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
            players: room.players.map(p => p.name)
        }));
}

function broadcastPublicRooms() {
    io.emit('publicRoomsList', getPublicRooms());
}

function broadcastRoomState(roomCode) {
    io.to(roomCode).emit('roomStateUpdate', getRoomStateForClient(rooms[roomCode]));
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.on('createRoom', ({ playerName, isPublic, maxPlayers, totalRounds, roundTime, userId }) => {
        const roomCode = generateRoomCode();
        const clampedMax = Math.min(Math.max(maxPlayers || DEFAULT_MAX_PLAYERS, 2), 12);
        const clampedRounds = Math.min(Math.max(totalRounds || DEFAULT_ROUNDS, 1), 15);
        const clampedTime = Math.min(Math.max(roundTime || DEFAULT_ROUND_TIME, 30), 180);

        rooms[roomCode] = {
            code: roomCode,
            players: [],
            gameState: 'waiting',
            hostId: socket.id,
            isPublic: isPublic !== false,
            maxPlayers: clampedMax,
            totalRounds: clampedRounds,
            roundTime: clampedTime,
            currentRound: 0,
            currentLetters: [],
            roundTimer: null,
            roundEndsAt: 0,
            roundEnded: false,
            usedWords: {},
            cleanupTimer: null
        };

        const token = crypto.randomBytes(16).toString('hex');
        addPlayerToRoom(roomCode, socket.id, playerName, true, !!userId, userId, token);
        socket.join(roomCode);
        socket.emit('playerToken', { roomCode, token });

        broadcastRoomState(roomCode);
        if (rooms[roomCode].isPublic) broadcastPublicRooms();
    });

    socket.on('getPublicRooms', () => {
        socket.emit('publicRoomsList', getPublicRooms());
    });

    socket.on('joinRoom', ({ roomCode, playerName, userId }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'La sala no existe.');
        if (room.gameState !== 'waiting') return socket.emit('error', 'La partida ya ha comenzado.');
        if (room.players.length >= room.maxPlayers) return socket.emit('error', 'La sala está llena.');

        const token = crypto.randomBytes(16).toString('hex');
        addPlayerToRoom(roomCode, socket.id, playerName, false, !!userId, userId, token);
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

        if (room.gameState === 'playing') {
            const letterCount = room.currentLetters.length;
            socket.emit('roundStart', {
                round: room.currentRound,
                totalRounds: room.totalRounds,
                letters: room.currentLetters,
                time: Math.max(1, Math.ceil((room.roundEndsAt - Date.now()) / 1000)),
                rejoined: true
            });
        }
        if (room.gameState === 'finished') {
            socket.emit('error', 'La partida ya ha terminado.');
            return;
        }
        broadcastRoomState(roomCode);
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

    socket.on('submitWord', ({ word }) => {
        const roomCode = findRoomBySocket(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const cleanWord = word.trim().toLowerCase();
        if (cleanWord.length < MIN_WORD_LENGTH) return;

        // Words with/without accents are the same word for duplicate purposes
        // (ñ stays distinct). Words found are kept as typed for display.
        const wordKey = normalizeForMatch(cleanWord);
        if (player.wordsThisRound.has(wordKey)) {
            return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'duplicate', points: 0 });
        }

        if (!isWordValid(cleanWord, room.currentLetters)) {
            return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'invalid', points: 0 });
        }

        const roundKey = `${roomCode}_r${room.currentRound}`;
        if (!room.usedWords[roundKey]) room.usedWords[roundKey] = new Set();
        if (room.usedWords[roundKey].has(wordKey)) {
            return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'used_by_other', points: 0 });
        }

        room.usedWords[roundKey].add(wordKey);
        player.wordsThisRound.add(wordKey);
        player.wordsFound.push(cleanWord);

        const points = calculateScore(cleanWord);
        player.score += points;
        player.totalWordsFound++;

        socket.emit('wordResult', { word: cleanWord, valid: true, reason: 'ok', points });
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
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                if (room.roundTimer) clearTimeout(room.roundTimer);
                if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
                delete rooms[roomCode];
                return;
            }
            if (room.hostId === socket.id) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
            }
            broadcastRoomState(roomCode);
            if (room.isPublic) broadcastPublicRooms();
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
        totalWordsFound: 0,
        isHost,
        isGuest: !isGuest,
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
            delete rooms[roomCode];
        }
    }, RESUME_GRACE_MS);
}

function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const letterCount = MIN_LETTERS + Math.floor(Math.random() * (MAX_LETTERS - MIN_LETTERS + 1));
    room.currentLetters = generateLetters(letterCount);
    room.roundEnded = false;
    room.roundEndsAt = Date.now() + room.roundTime * 1000;

    room.players.forEach(p => { p.wordsThisRound = new Set(); });

    io.to(roomCode).emit('roundStart', {
        round: room.currentRound,
        totalRounds: room.totalRounds,
        letters: room.currentLetters,
        time: room.roundTime
    });
    broadcastRoomState(roomCode);

    room.roundTimer = setTimeout(() => endRound(roomCode), room.roundTime * 1000);
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

    const roundResults = room.players.map(p => ({
        id: p.id,
        name: p.name,
        wordsThisRound: Array.from(p.wordsThisRound),
        scoreThisRound: Array.from(p.wordsThisRound).reduce((sum, w) => sum + calculateScore(w), 0),
        totalScore: p.score
    }));

    io.to(roomCode).emit('roundEnd', {
        round: room.currentRound,
        results: roundResults,
        letters: room.currentLetters
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

    room.gameState = 'finished';

    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    const winner = sorted[0];

    io.to(roomCode).emit('gameOver', {
        winner: { id: winner.id, name: winner.name, score: winner.score },
        players: sorted.map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            wordsFound: p.wordsFound
        }))
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

    // Clean up after delay
    setTimeout(() => {
        if (rooms[roomCode]) {
            if (rooms[roomCode].roundTimer) clearTimeout(rooms[roomCode].roundTimer);
            delete rooms[roomCode];
        }
    }, 30000);
}

// --- SERVER INIT ---
async function startServer() {
    await runDatabaseMigrations();
    await loadValidWords();

    const activePort = server instanceof https.Server ? PORT_HTTPS : PORT_HTTP;
    const protocol = server instanceof https.Server ? 'https' : 'http';

    server.listen(activePort, () => {
        console.log(`\nPalabrero running on ${protocol}://localhost:${activePort}`);
        console.log("Ready to accept connections.");
    });
}

startServer();
