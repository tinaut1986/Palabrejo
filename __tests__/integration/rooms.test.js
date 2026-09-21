const { bootTestServer, stopTestServer, connect, waitFor, emitAndWait, uniqueUsername } = require('./testServer');

jest.setTimeout(15000);

describe('salas: crear, unirse y rechazos', () => {
    let server;

    beforeAll(async () => {
        server = await bootTestServer();
    });

    afterAll(async () => {
        await stopTestServer(server);
    });

    test('crear sala devuelve token y aparece como jugador único', async () => {
        const host = await connect(server.baseUrl);
        const [{ roomCode, token }, state] = await emitAndWait(
            host, 'createRoom', { playerName: uniqueUsername('host'), isPublic: false },
            ['playerToken', 'roomStateUpdate']
        );
        expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);
        expect(token).toBeTruthy();
        expect(state.players).toHaveLength(1);
        expect(state.players[0].isHost).toBe(true);
        host.disconnect();
    });

    test('un segundo jugador puede unirse y ambos ven la sala actualizada', async () => {
        const host = await connect(server.baseUrl);
        const [{ roomCode }] = await emitAndWait(
            host, 'createRoom', { playerName: uniqueUsername('host'), isPublic: false },
            ['playerToken', 'roomStateUpdate']
        );

        const guest = await connect(server.baseUrl);
        const hostSeesUpdate = waitFor(host, 'roomStateUpdate');
        await emitAndWait(guest, 'joinRoom', { roomCode, playerName: uniqueUsername('guest') }, 'playerToken');
        const state = await hostSeesUpdate;
        expect(state.players).toHaveLength(2);

        host.disconnect();
        guest.disconnect();
    });

    test('unirse a una sala inexistente da error', async () => {
        const guest = await connect(server.baseUrl);
        const err = await emitAndWait(guest, 'joinRoom', { roomCode: 'ZZZZ', playerName: uniqueUsername('guest') }, 'error');
        expect(err).toMatch(/no existe/i);
        guest.disconnect();
    });

    test('unirse a una sala llena da error', async () => {
        const host = await connect(server.baseUrl);
        const [{ roomCode }] = await emitAndWait(
            host, 'createRoom', { playerName: uniqueUsername('host'), isPublic: false, maxPlayers: 2 },
            ['playerToken', 'roomStateUpdate']
        );

        const p2 = await connect(server.baseUrl);
        const hostSeesP2 = waitFor(host, 'roomStateUpdate');
        await emitAndWait(p2, 'joinRoom', { roomCode, playerName: uniqueUsername('p2') }, 'playerToken');
        await hostSeesP2;

        const p3 = await connect(server.baseUrl);
        const err = await emitAndWait(p3, 'joinRoom', { roomCode, playerName: uniqueUsername('p3') }, 'error');
        expect(err).toMatch(/llena/i);

        host.disconnect();
        p2.disconnect();
        p3.disconnect();
    });

    test('unirse a una partida ya empezada da error', async () => {
        const host = await connect(server.baseUrl);
        const [{ roomCode }] = await emitAndWait(
            host, 'createRoom', { playerName: uniqueUsername('host'), isPublic: false },
            ['playerToken', 'roomStateUpdate']
        );
        await emitAndWait(host, 'startGame', undefined, 'roundStart');

        const late = await connect(server.baseUrl);
        const err = await emitAndWait(late, 'joinRoom', { roomCode, playerName: uniqueUsername('late') }, 'error');
        expect(err).toMatch(/ya ha comenzado/i);

        host.disconnect();
        late.disconnect();
    });

    test('leaveRoom saca al jugador y el resto lo ve', async () => {
        const host = await connect(server.baseUrl);
        const [{ roomCode }] = await emitAndWait(
            host, 'createRoom', { playerName: uniqueUsername('host'), isPublic: false },
            ['playerToken', 'roomStateUpdate']
        );

        const guest = await connect(server.baseUrl);
        const hostSeesJoin = waitFor(host, 'roomStateUpdate');
        await emitAndWait(guest, 'joinRoom', { roomCode, playerName: uniqueUsername('guest') }, 'playerToken');
        await hostSeesJoin;

        const hostSeesLeave = waitFor(host, 'roomStateUpdate');
        guest.emit('leaveRoom');
        const state = await hostSeesLeave;
        expect(state.players).toHaveLength(1);

        host.disconnect();
        guest.disconnect();
    });
});
