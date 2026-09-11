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

// Descanso entre partidas completas: tras el fin de la ultima ronda se espera
// este tiempo y arranca una partida nueva con las mismas condiciones y los
// jugadores que sigan en sala.
const NEXT_GAME_DELAY_MS = 20 * 1000;
const MIN_VOWELS = 2;
const VOWELS = ['A', 'E', 'I', 'O', 'U'];

// Una mano sin apenas palabras jugables no tiene gracia: antes de empezar (y
// en cada ronda) se descarta un rack que rinda menos palabras que este minimo.
// Se prueban hasta MAX_LETTER_ROLL_ATTEMPTS juegos de letras y, si ninguno
// alcanza el minimo, se usa el mejor de los probados para no bloquear la sala.
const MIN_PLAYABLE_WORDS = 30;
const MAX_LETTER_ROLL_ATTEMPTS = 20;

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

// --- SESIONES FIRMADAS ---
// El cliente guarda un token; el servidor NO se cree el userId que le manden.
// Formato: base64url(userId.expiraEnMs).base64url(HMAC-SHA256)
// Duracion de la sesion en dias. 0 (por defecto) = no caduca nunca: en el
// token se firma un 0 en lugar de una fecha. La sesion sigue siendo revocable
// por token_version, asi que "para siempre" no significa "sin control".
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 0);
const SESSION_TTL_MS = SESSION_TTL_DAYS > 0
    ? SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
    : 0;
const NEVER_EXPIRES = 0;
let sessionSecret = null;

// El secreto se guarda en la base de datos: asi sobrevive a reconstruir el
// contenedor y las sesiones abiertas no se invalidan en cada despliegue.
async function loadSessionSecret() {
    if (process.env.SESSION_SECRET) {
        sessionSecret = process.env.SESSION_SECRET;
        return;
    }
    const [rows] = await dbPool.query('SELECT value FROM app_settings WHERE name = ?', ['session_secret']);
    if (rows.length > 0) {
        sessionSecret = rows[0].value;
        return;
    }
    sessionSecret = crypto.randomBytes(48).toString('hex');
    // INSERT IGNORE: si dos arranques coinciden, gana el primero
    await dbPool.query('INSERT IGNORE INTO app_settings (name, value) VALUES (?, ?)', ['session_secret', sessionSecret]);
    const [confirmed] = await dbPool.query('SELECT value FROM app_settings WHERE name = ?', ['session_secret']);
    sessionSecret = confirmed[0].value;
}

const b64url = buf => Buffer.from(buf).toString('base64url');

function signSession(userId, tokenVersion) {
    const expiresAt = SESSION_TTL_MS > 0 ? Date.now() + SESSION_TTL_MS : NEVER_EXPIRES;
    const payload = `${userId}.${tokenVersion}.${expiresAt}`;
    const mac = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
    return `${b64url(payload)}.${b64url(mac)}`;
}

// Comprueba firma y caducidad. Devuelve { userId, tokenVersion } o null.
// La version se contrasta despues contra la base de datos: un token firmado
// sigue siendo revocable incrementando users.token_version.
function parseSession(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    let payload, mac;
    try {
        payload = Buffer.from(parts[0], 'base64url').toString('utf8');
        mac = Buffer.from(parts[1], 'base64url');
    } catch (e) { return null; }

    const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
    if (mac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(mac, expected)) return null;

    const [rawId, rawVersion, rawExp] = payload.split('.');
    const userId = parseInt(rawId, 10);
    const tokenVersion = parseInt(rawVersion, 10);
    const expiresAt = parseInt(rawExp, 10);
    if (!Number.isInteger(userId) || !Number.isInteger(tokenVersion) || !Number.isInteger(expiresAt)) return null;
    // Los tokens emitidos con caducidad siguen respetandola
    if (expiresAt !== NEVER_EXPIRES && Date.now() >= expiresAt) return null;
    return { userId, tokenVersion };
}

// Valida el token de punta a punta: firma, caducidad y que la version siga
// siendo la vigente. Devuelve { userId, username } o null.
async function verifySession(token) {
    const parsed = parseSession(token);
    if (!parsed) return null;
    try {
        const [rows] = await dbPool.query(
            'SELECT username, token_version FROM users WHERE id = ?', [parsed.userId]
        );
        if (rows.length === 0) return null;
        if (rows[0].token_version !== parsed.tokenVersion) return null;
        return { userId: parsed.userId, username: rows[0].username };
    } catch (error) {
        console.error("Session verify error:", error);
        return null;
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

        res.status(201).json({
            message: 'Registro exitoso.',
            username,
            token: signSession(result.insertId, 0)
        });
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
        const [rows] = await dbPool.query('SELECT id, username, password_hash, token_version FROM users WHERE username = ?', [username]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        }

        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        }

        res.json({
            message: 'Login exitoso.',
            username: user.username,
            token: signSession(user.id, user.token_version)
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ error: 'Error del servidor.' });
    }
});

// Revalida el token que el cliente tiene guardado al arrancar
app.post('/api/session', async (req, res) => {
    const session = await verifySession(req.body?.token);
    if (!session) return res.status(401).json({ error: 'Sesión no válida o caducada.' });
    res.json({ username: session.username });
});

// Los nombres de cuentas registradas estan reservados para invitados.
// Se consulta al entrar como invitado, para avisar en el momento oportuno.
app.get('/api/name-available/:name', async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nombre requerido.' });
    res.json({ available: !(await isNameRegistered(name)) });
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

// --- AMIGOS ---
// Todas estas rutas exigen sesion: la identidad sale del token, nunca de un
// nombre que mande el cliente.
async function requireSession(req, res, next) {
    const header = req.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.body?.token;
    const session = await verifySession(token);
    if (!session) return res.status(401).json({ error: 'Sesión no válida o caducada.' });
    req.session = session;
    next();
}

const STATS_COLUMNS = `
    COALESCE(us.games_played, 0) AS games_played,
    COALESCE(us.games_won, 0) AS games_won,
    COALESCE(us.total_words, 0) AS total_words,
    COALESCE(us.total_score, 0) AS total_score,
    COALESCE(us.best_score, 0) AS best_score
`;

function withAverage(row) {
    const games = Number(row.games_played) || 0;
    return {
        username: row.username,
        games_played: games,
        games_won: Number(row.games_won) || 0,
        total_words: Number(row.total_words) || 0,
        total_score: Number(row.total_score) || 0,
        best_score: Number(row.best_score) || 0,
        avg_score: games > 0 ? Math.round((Number(row.total_score) / games) * 10) / 10 : 0
    };
}

// Amigos aceptados y solicitudes en ambos sentidos, con estadisticas para
// poder comparar sin una segunda llamada
app.get('/api/friends', requireSession, async (req, res) => {
    const me = req.session.userId;
    try {
        const [rows] = await dbPool.query(`
            SELECT u.username, f.status, ${STATS_COLUMNS},
                   CASE WHEN f.requester_id = ? THEN 'out' ELSE 'in' END AS direction
            FROM friendships f
            JOIN users u ON u.id = IF(f.requester_id = ?, f.addressee_id, f.requester_id)
            LEFT JOIN user_stats us ON us.user_id = u.id
            WHERE f.requester_id = ? OR f.addressee_id = ?
            ORDER BY u.username
        `, [me, me, me, me]);

        const [mine] = await dbPool.query(`
            SELECT u.username, ${STATS_COLUMNS}
            FROM users u LEFT JOIN user_stats us ON us.user_id = u.id
            WHERE u.id = ?
        `, [me]);

        res.json({
            me: withAverage(mine[0]),
            friends: rows.filter(r => r.status === 'accepted').map(withAverage),
            incoming: rows.filter(r => r.status === 'pending' && r.direction === 'in').map(r => r.username),
            outgoing: rows.filter(r => r.status === 'pending' && r.direction === 'out').map(r => r.username)
        });
    } catch (error) {
        console.error("Friends error:", error);
        res.status(500).json({ error: 'Error del servidor.' });
    }
});

// Localiza al otro usuario y la relacion existente, en el sentido que sea
async function findRelation(me, username) {
    const [users] = await dbPool.query('SELECT id, username FROM users WHERE username = ?', [username]);
    if (users.length === 0) return { missing: true };
    const other = users[0];
    if (other.id === me) return { self: true };
    const [rows] = await dbPool.query(
        `SELECT requester_id, addressee_id, status FROM friendships
         WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
        [me, other.id, other.id, me]
    );
    return { other, relation: rows[0] || null };
}

app.post('/api/friends/request', requireSession, async (req, res) => {
    const me = req.session.userId;
    const username = String(req.body?.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Indica un nombre de usuario.' });

    try {
        const { missing, self, other, relation } = await findRelation(me, username);
        if (missing) return res.status(404).json({ error: `No existe ningún jugador llamado "${username}".` });
        if (self) return res.status(400).json({ error: 'No puedes añadirte a ti mismo.' });

        if (relation) {
            if (relation.status === 'accepted') {
                return res.status(409).json({ error: `Ya sois amigos.` });
            }
            // Si el otro ya te habia invitado, pedirlo equivale a aceptar
            if (relation.addressee_id === me) {
                await dbPool.query(
                    `UPDATE friendships SET status = 'accepted', responded_at = NOW()
                     WHERE requester_id = ? AND addressee_id = ?`,
                    [other.id, me]
                );
                return res.json({ status: 'accepted' });
            }
            return res.status(409).json({ error: 'Ya le enviaste una solicitud.' });
        }

        await dbPool.query(
            'INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)',
            [me, other.id]
        );
        res.json({ status: 'pending' });
    } catch (error) {
        console.error("Friend request error:", error);
        res.status(500).json({ error: 'Error del servidor.' });
    }
});

app.post('/api/friends/accept', requireSession, async (req, res) => {
    const me = req.session.userId;
    const username = String(req.body?.username || '').trim();
    try {
        const { missing, other, relation } = await findRelation(me, username);
        if (missing) return res.status(404).json({ error: 'Usuario no encontrado.' });
        // Solo se acepta lo que otro te ha pedido
        if (!relation || relation.status !== 'pending' || relation.addressee_id !== me) {
            return res.status(404).json({ error: 'No hay ninguna solicitud de ese jugador.' });
        }
        await dbPool.query(
            `UPDATE friendships SET status = 'accepted', responded_at = NOW()
             WHERE requester_id = ? AND addressee_id = ?`,
            [other.id, me]
        );
        res.json({ status: 'accepted' });
    } catch (error) {
        console.error("Friend accept error:", error);
        res.status(500).json({ error: 'Error del servidor.' });
    }
});

// Sirve para rechazar, cancelar una solicitud propia y eliminar a un amigo
app.post('/api/friends/remove', requireSession, async (req, res) => {
    const me = req.session.userId;
    const username = String(req.body?.username || '').trim();
    try {
        const { missing, other, relation } = await findRelation(me, username);
        if (missing) return res.status(404).json({ error: 'Usuario no encontrado.' });
        if (!relation) return res.status(404).json({ error: 'No hay ninguna relación con ese jugador.' });
        await dbPool.query(
            `DELETE FROM friendships
             WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
            [me, other.id, other.id, me]
        );
        res.json({ status: 'removed' });
    } catch (error) {
        console.error("Friend remove error:", error);
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

// Cuenta cuantas palabras del diccionario pueden formarse con un rack dado.
// Reproduce la misma logica que isWordValid: cada letra del rack puede
// reutilizarse, y se mira la forma canónica (sin acentos, con ñ).
function countPlayableWords(letters) {
    const letterSet = new Set(letters.map(l => normalizeForMatch(l)));
    let count = 0;
    for (const canonical of validWordsCanonical) {
        if (canonical.length < MIN_WORD_LENGTH) continue;
        let ok = true;
        for (let i = 0; i < canonical.length; i++) {
            if (!letterSet.has(canonical[i])) { ok = false; break; }
        }
        if (ok) count++;
    }
    return count;
}

// Elige un juego de letras con garantia de palabras jugables: prueba varios
// racks al azar y se queda con el primero que pase el minimo (o el mejor
// hallazgo si ninguno llega, para no bloquear la sala nunca).
function selectPlayableLetters(count) {
    let best = null;
    for (let i = 0; i < MAX_LETTER_ROLL_ATTEMPTS; i++) {
        const letters = generateLetters(count);
        const words = countPlayableWords(letters);
        if (!best || words > best.words) best = { letters, words };
        if (words >= MIN_PLAYABLE_WORDS) break;
    }
    return best.letters;
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

// Nombre de invitado: se limpia aqui porque llega tal cual del cliente
function sanitizeGuestName(name) {
    const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
    return clean.length >= 2 ? clean : 'Invitado';
}

// Los nombres registrados estan reservados: un invitado no puede presentarse
// con el nombre de una cuenta ajena aunque no pueda usurpar sus estadisticas.
async function isNameRegistered(name) {
    try {
        const [rows] = await dbPool.query('SELECT id FROM users WHERE username = ?', [name]);
        return rows.length > 0;
    } catch (error) {
        console.error("Name check error:", error);
        return false;
    }
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
io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.on('createRoom', async ({ playerName, isPublic, maxPlayers, totalRounds, roundTime, sessionToken }) => {
        const player = await resolvePlayer(sessionToken, playerName);
        if (player.expired) return emitSessionExpired(socket);
        if (player.error) return socket.emit('error', player.error);

        detachSocketFromRooms(socket);

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
            cleanupTimer: null,
            restTimer: null,
            restEndsAt: 0
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
                    points: calculateScore(w)
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

    room.gameState = 'rest';

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
    });

    startRound(roomCode);
}

// --- SERVER INIT ---
async function startServer() {
    await runDatabaseMigrations();
    await loadSessionSecret();
    await loadValidWords();

    const activePort = server instanceof https.Server ? PORT_HTTPS : PORT_HTTP;
    const protocol = server instanceof https.Server ? 'https' : 'http';

    server.listen(activePort, () => {
        console.log(`\nPalabrejo running on ${protocol}://localhost:${activePort}`);
        console.log("Ready to accept connections.");
    });
}

startServer();
