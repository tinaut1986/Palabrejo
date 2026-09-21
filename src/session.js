// Sesiones firmadas (login) e identidad de cuentas registradas. Lo usan
// tanto las rutas HTTP (src/routes/auth.js) como los handlers de socket
// (createRoom/joinRoom en server.js) — es el UNICO sitio con esta logica.
//
// El cliente guarda un token; el servidor NO se cree el userId que le manden.
// Formato: base64url(userId.expiraEnMs).base64url(HMAC-SHA256)
// Duracion de la sesion en dias. 0 (por defecto) = no caduca nunca: en el
// token se firma un 0 en lugar de una fecha. La sesion sigue siendo revocable
// por token_version, asi que "para siempre" no significa "sin control".
const crypto = require('crypto');

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 0);
const SESSION_TTL_MS = SESSION_TTL_DAYS > 0
    ? SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
    : 0;
const NEVER_EXPIRES = 0;

const b64url = buf => Buffer.from(buf).toString('base64url');

// `getDbPool` se pasa como funcion (no como pool directo) porque el pool
// real se crea DESPUES de las migraciones: una funcion siempre lee el valor
// vigente, un valor capturado en el momento de construir este modulo estaria
// desactualizado (undefined) cuando arranca el server.
function createSessionModule({ getDbPool }) {
    let sessionSecret = null;

    // El secreto se guarda en la base de datos: asi sobrevive a reconstruir
    // el contenedor y las sesiones abiertas no se invalidan en cada despliegue.
    async function loadSessionSecret() {
        if (process.env.SESSION_SECRET) {
            sessionSecret = process.env.SESSION_SECRET;
            return;
        }
        const dbPool = getDbPool();
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

    function signSession(userId, tokenVersion) {
        const expiresAt = SESSION_TTL_MS > 0 ? Date.now() + SESSION_TTL_MS : NEVER_EXPIRES;
        const payload = `${userId}.${tokenVersion}.${expiresAt}`;
        const mac = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
        return `${b64url(payload)}.${b64url(mac)}`;
    }

    // Comprueba firma y caducidad. Devuelve { userId, tokenVersion } o null.
    // La version se contrasta despues contra la base de datos: un token
    // firmado sigue siendo revocable incrementando users.token_version.
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

    // Valida el token de punta a punta: firma, caducidad y que la version
    // siga siendo la vigente. Devuelve { userId, username } o null.
    async function verifySession(token) {
        const parsed = parseSession(token);
        if (!parsed) return null;
        try {
            const [rows] = await getDbPool().query(
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

    // Los nombres registrados estan reservados: un invitado no puede
    // presentarse con el nombre de una cuenta ajena aunque no pueda usurpar
    // sus estadisticas.
    async function isNameRegistered(name) {
        try {
            const [rows] = await getDbPool().query('SELECT id FROM users WHERE username = ?', [name]);
            return rows.length > 0;
        } catch (error) {
            console.error("Name check error:", error);
            return false;
        }
    }

    return { loadSessionSecret, signSession, verifySession, isNameRegistered };
}

module.exports = { createSessionModule };
