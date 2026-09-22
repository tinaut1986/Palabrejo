const { bootTestServer, stopTestServer } = require('./testServer');

describe('HTTP: endpoint de QR local (issue #4)', () => {
    let server;

    beforeAll(async () => { server = await bootTestServer(); });
    afterAll(async () => { await stopTestServer(server); });

    test('genera un PNG a partir de la URL de sala', async () => {
        const url = encodeURIComponent('https://palabrejo.test/?join=ABCD');
        const res = await fetch(`${server.baseUrl}/api/qr?data=${url}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/png');

        const buf = Buffer.from(await res.arrayBuffer());
        // Cabecera PNG: no basta un 200, tiene que ser un QR real decodificable
        expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(buf.length).toBeGreaterThan(100);
    });

    test('rechaza data vacía o demasiado larga', async () => {
        const empty = await fetch(`${server.baseUrl}/api/qr?data=`);
        expect(empty.status).toBe(400);

        const long = await fetch(`${server.baseUrl}/api/qr?data=${'x'.repeat(500)}`);
        expect(long.status).toBe(400);
    });
});