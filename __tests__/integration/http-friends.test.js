const { bootTestServer, stopTestServer, uniqueUsername, registerUser } = require('./testServer');

jest.setTimeout(15000);

async function api(baseUrl, path, { method = 'GET', token, body } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}

describe('HTTP: amigos y leaderboard', () => {
    let server;

    beforeAll(async () => { server = await bootTestServer(); });
    afterAll(async () => { await stopTestServer(server); });

    test('las rutas de amigos exigen sesión', async () => {
        const res = await api(server.baseUrl, '/api/friends');
        expect(res.status).toBe(401);
    });

    test('pedir amistad, ver la solicitud y aceptarla deja a ambos como amigos', async () => {
        const a = await registerUser(server.baseUrl);
        const b = await registerUser(server.baseUrl);

        const request = await api(server.baseUrl, '/api/friends/request', { method: 'POST', token: a.token, body: { username: b.username } });
        expect(request.status).toBe(200);
        expect(request.body.status).toBe('pending');

        const bView = await api(server.baseUrl, '/api/friends', { token: b.token });
        expect(bView.body.incoming).toContain(a.username);

        const accept = await api(server.baseUrl, '/api/friends/accept', { method: 'POST', token: b.token, body: { username: a.username } });
        expect(accept.status).toBe(200);
        expect(accept.body.status).toBe('accepted');

        const aView = await api(server.baseUrl, '/api/friends', { token: a.token });
        expect(aView.body.friends.map(f => f.username)).toContain(b.username);
        const bViewAfter = await api(server.baseUrl, '/api/friends', { token: b.token });
        expect(bViewAfter.body.friends.map(f => f.username)).toContain(a.username);
    });

    test('pedir amistad a quien ya te la pidió equivale a aceptarla', async () => {
        const a = await registerUser(server.baseUrl);
        const b = await registerUser(server.baseUrl);

        await api(server.baseUrl, '/api/friends/request', { method: 'POST', token: a.token, body: { username: b.username } });
        const reverse = await api(server.baseUrl, '/api/friends/request', { method: 'POST', token: b.token, body: { username: a.username } });
        expect(reverse.body.status).toBe('accepted');
    });

    test('no se puede pedir amistad a uno mismo ni a quien no existe', async () => {
        const a = await registerUser(server.baseUrl);

        const self = await api(server.baseUrl, '/api/friends/request', { method: 'POST', token: a.token, body: { username: a.username } });
        expect(self.status).toBe(400);

        const missing = await api(server.baseUrl, '/api/friends/request', { method: 'POST', token: a.token, body: { username: uniqueUsername('fantasma') } });
        expect(missing.status).toBe(404);
    });

    test('remove borra la amistad en ambos sentidos', async () => {
        const a = await registerUser(server.baseUrl);
        const b = await registerUser(server.baseUrl);
        await api(server.baseUrl, '/api/friends/request', { method: 'POST', token: a.token, body: { username: b.username } });
        await api(server.baseUrl, '/api/friends/accept', { method: 'POST', token: b.token, body: { username: a.username } });

        const remove = await api(server.baseUrl, '/api/friends/remove', { method: 'POST', token: a.token, body: { username: b.username } });
        expect(remove.status).toBe(200);

        const aView = await api(server.baseUrl, '/api/friends', { token: a.token });
        expect(aView.body.friends.map(f => f.username)).not.toContain(b.username);
    });

    test('leaderboard es público y no incluye a quien no ha jugado ninguna partida', async () => {
        const { username } = await registerUser(server.baseUrl);
        const res = await fetch(`${server.baseUrl}/api/leaderboard`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.map(r => r.username)).not.toContain(username); // games_played = 0
    });
});
