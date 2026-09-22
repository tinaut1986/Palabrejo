// Helper compartido por los tests de integración (issue #8). No es un test
// en sí (no matchea *.test.js): arranca el server real contra una base de
// datos de test aislada (palabrejo_test_db, no la de producción) en un
// puerto libre, y da utilidades para hablar con él por HTTP y sockets.
const { io: ioClient } = require('socket.io-client');

// Hay que fijar las variables de entorno ANTES de requerir server.js: lee
// PORT/DB_* en el top-level del módulo, no en startServer().
process.env.PORT = process.env.PORT || '0';
process.env.DB_NAME = process.env.DB_NAME || 'palabrejo_test_db';
process.env.DB_HOST = process.env.DB_HOST || 'db';
// Forzar HTTP: la suite habla por http:// (fetch + websocket). En una maquina
// con certificados en /ssl/keys, sin este flag el server arrancaria HTTPS:3001
// y ninguna prueba de integracion funcionaria (ver server.js).
process.env.FORCE_HTTP = process.env.FORCE_HTTP || '1';

async function bootTestServer() {
    // Cada test file requiere este helper en su propio registro de módulos
    // (jest aísla por fichero), así que este require da una instancia nueva
    // de server.js con sus propias `rooms` en memoria.
    const server = require('../../server');
    await server.startServer();
    const port = server.server.address().port;
    return { ...server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopTestServer(server) {
    await server.stopServer();
}

// Conecta un cliente de socket.io y espera a que confirme la conexión.
function connect(baseUrl) {
    return new Promise((resolve, reject) => {
        // reconnection:false es clave para que el proceso de test termine
        // limpio: si el server cierra la conexión (stopServer) y el cliente
        // intenta reconectar solo, deja temporizadores vivos que Jest ve
        // como "handles abiertos" y no sale del proceso.
        const socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}

// Espera un único evento (con timeout, para no colgar el test si el server
// no responde lo esperado).
function waitFor(socket, event, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout esperando '${event}'`)), timeoutMs);
        socket.once(event, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

// El servidor a veces manda dos eventos seguidos sin esperar nada entre
// medias (p.ej. 'playerToken' y luego 'roomStateUpdate' en el mismo
// handler): si se espera uno con `await` y LUEGO se registra el listener del
// otro, el segundo puede haber llegado ya y perderse (sin listener a
// tiempo). Este helper registra TODOS los listeners antes de emitir, para no
// depender de en qué orden se los espere después.
function emitAndWait(socket, event, payload, waitEvents, timeoutMs) {
    const list = Array.isArray(waitEvents) ? waitEvents : [waitEvents];
    const promises = list.map(e => waitFor(socket, e, timeoutMs));
    socket.emit(event, payload);
    return Array.isArray(waitEvents) ? Promise.all(promises) : promises[0];
}

// Usuario único por llamada (nombre y contraseña válidos) para no chocar con
// restos de ejecuciones anteriores contra la misma BD de test.
function uniqueUsername(prefix = 'test') {
    return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function registerUser(baseUrl, username = uniqueUsername()) {
    const res = await fetch(`${baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'clave-test-1234' })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`registro fallido: ${JSON.stringify(body)}`);
    return { username, token: body.token };
}

module.exports = { bootTestServer, stopTestServer, connect, waitFor, emitAndWait, uniqueUsername, registerUser };
