const { bootTestServer, stopTestServer, uniqueUsername, registerUser } = require('./testServer');

jest.setTimeout(15000);

async function postJson(baseUrl, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
}

describe('HTTP: registro, login y sesión', () => {
    let server;

    beforeAll(async () => { server = await bootTestServer(); });
    afterAll(async () => { await stopTestServer(server); });

    test('registro válido devuelve token y 201', async () => {
        const username = uniqueUsername('reg');
        const { status, body } = await postJson(server.baseUrl, '/api/register', { username, password: 'clave-test-1234' });
        expect(status).toBe(201);
        expect(body.username).toBe(username);
        expect(body.token).toBeTruthy();
    });

    test('registro rechaza contraseña corta, nombre inválido y nombre duplicado', async () => {
        const short = await postJson(server.baseUrl, '/api/register', { username: uniqueUsername('u'), password: 'abc' });
        expect(short.status).toBe(400);

        const badChars = await postJson(server.baseUrl, '/api/register', { username: 'con espacios!', password: 'clave-test-1234' });
        expect(badChars.status).toBe(400);

        const username = uniqueUsername('dup');
        await postJson(server.baseUrl, '/api/register', { username, password: 'clave-test-1234' });
        const dup = await postJson(server.baseUrl, '/api/register', { username, password: 'otra-clave-1234' });
        expect(dup.status).toBe(409);
    });

    test('login correcto devuelve token; incorrecto da 401', async () => {
        const { username } = await registerUser(server.baseUrl);

        const bad = await postJson(server.baseUrl, '/api/login', { username, password: 'contraseña-mala' });
        expect(bad.status).toBe(401);

        const ok = await postJson(server.baseUrl, '/api/login', { username, password: 'clave-test-1234' });
        expect(ok.status).toBe(200);
        expect(ok.body.token).toBeTruthy();
    });

    test('/api/session revalida un token bueno y rechaza uno inventado', async () => {
        const { username, token } = await registerUser(server.baseUrl);

        const ok = await postJson(server.baseUrl, '/api/session', { token });
        expect(ok.status).toBe(200);
        expect(ok.body.username).toBe(username);

        const bad = await postJson(server.baseUrl, '/api/session', { token: 'esto-no-es-un-token' });
        expect(bad.status).toBe(401);
    });

    test('/api/name-available detecta nombres de cuentas registradas', async () => {
        const { username } = await registerUser(server.baseUrl);

        const taken = await fetch(`${server.baseUrl}/api/name-available/${encodeURIComponent(username)}`);
        expect((await taken.json()).available).toBe(false);

        const free = await fetch(`${server.baseUrl}/api/name-available/${uniqueUsername('libre')}`);
        expect((await free.json()).available).toBe(true);
    });

    test('/api/profile/:username devuelve estadísticas a cero para un recién registrado', async () => {
        const { username } = await registerUser(server.baseUrl);
        const res = await fetch(`${server.baseUrl}/api/profile/${encodeURIComponent(username)}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.games_played).toBe(0);
        expect(body.best_score).toBe(0);
    });

    test('/api/profile/:username da 404 si no existe', async () => {
        const res = await fetch(`${server.baseUrl}/api/profile/${uniqueUsername('fantasma')}`);
        expect(res.status).toBe(404);
    });
});
