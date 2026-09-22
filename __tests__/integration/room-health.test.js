const { bootTestServer, stopTestServer, connect, waitFor, emitAndWait, uniqueUsername } = require('./testServer');
const { WAITING_HOST_TTL_MS, AFK_WARN_MS } = require('../../lib/room-health');

jest.setTimeout(15000);

async function createRoomWithGuest(server, { isPublic = false } = {}) {
    const host = await connect(server.baseUrl);
    const [{ roomCode }] = await emitAndWait(
        host, 'createRoom', { playerName: uniqueUsername('host'), isPublic, bonusesEnabled: false },
        ['playerToken', 'roomStateUpdate']
    );
    const guest = await connect(server.baseUrl);
    const hostSeesJoin = waitFor(host, 'roomStateUpdate');
    const guestName = uniqueUsername('guest');
    await emitAndWait(guest, 'joinRoom', { roomCode, playerName: guestName }, 'playerToken');
    await hostSeesJoin;
    return { host, guest, roomCode, guestName };
}

describe('salud de salas (issue #15)', () => {
    let server;

    beforeAll(async () => { server = await bootTestServer(); });
    afterAll(async () => { await stopTestServer(server); });

    test('sweep: sala waiting sin actividad del host desaparece y avisa a los que quedan', async () => {
        const { host, guest, roomCode } = await createRoomWithGuest(server, { isPublic: true });

        // El host dejo la sala abierta (sin actividad) mas alla de la ventana
        server.rooms[roomCode].lastHostActivity = Date.now() - WAITING_HOST_TTL_MS - 1000;

        const guestClosed = waitFor(guest, 'roomClosed');
        const hostClosed = waitFor(host, 'roomClosed');
        const { swept } = server.sweepRooms();

        expect(swept).toContain(roomCode);
        await Promise.all([guestClosed, hostClosed]);
        expect(server.rooms[roomCode]).toBeUndefined();

        host.disconnect();
        guest.disconnect();
    });

    test('el host puede expulsar a un jugador de la sala en espera', async () => {
        const { host, guest, roomCode, guestName } = await createRoomWithGuest(server);
        const guestId = server.rooms[roomCode].players.find(p => p.name === guestName).id;

        const kicked = waitFor(guest, 'kicked');
        const hostSeesLeave = waitFor(host, 'roomStateUpdate');
        host.emit('kickPlayer', { targetId: guestId });
        const [kickMsg, state] = await Promise.all([kicked, hostSeesLeave]);

        expect(kickMsg).toMatch(/expulsado/i);
        expect(state.players).toHaveLength(1);
        expect(server.rooms[roomCode].players.some(p => p.id === guestId)).toBe(false);

        host.disconnect();
        guest.disconnect();
    });

    test('un jugador no-host no puede expulsar a nadie', async () => {
        const { host, guest, roomCode, guestName } = await createRoomWithGuest(server);
        const hostId = server.rooms[roomCode].hostId;

        guest.emit('kickPlayer', { targetId: hostId });
        await new Promise(r => setTimeout(r, 200));
        expect(server.rooms[roomCode].players).toHaveLength(2);
        expect(server.rooms[roomCode].hostId).toBe(hostId);

        host.disconnect();
        guest.disconnect();
    });

    test('traspaso de host: pide permiso, avisa a la sala y el nuevo puede empezar', async () => {
        const { host, guest, roomCode, guestName } = await createRoomWithGuest(server);

        const hostRequest = waitFor(host, 'becomeHostRequest');
        guest.emit('becomeHost');
        const { requestId, requesterName } = await hostRequest;
        expect(requesterName).toBe(guestName);

        const notice = waitFor(host, 'roomNotice');
        const stateP = waitFor(host, 'roomStateUpdate');
        host.emit('respondHostRequest', { requestId, approve: true });
        const [noticeMsg, state] = await Promise.all([notice, stateP]);

        expect(noticeMsg.text).toMatch(/es el nuevo anfitrión/i);
        const newHost = state.players.find(p => p.id === guest.id);
        expect(newHost.isHost).toBe(true);
        expect(server.rooms[roomCode].hostId).toBe(guest.id);

        const guestRoundStart = waitFor(guest, 'roundStart');
        guest.emit('startGame');
        await guestRoundStart;

        host.disconnect();
        guest.disconnect();
    });

    test('rechazo de traspaso: el host conserva el rol y el solicitante se entera', async () => {
        const { host, guest, roomCode } = await createRoomWithGuest(server);

        const hostRequest = waitFor(host, 'becomeHostRequest');
        guest.emit('becomeHost');
        const { requestId } = await hostRequest;

        const guestNotice = waitFor(guest, 'roomNotice');
        host.emit('respondHostRequest', { requestId, approve: false });
        const noticeMsg = await guestNotice;
        expect(noticeMsg.text).toMatch(/rechazado/i);
        expect(server.rooms[roomCode].hostId).toBe(host.id);

        host.disconnect();
        guest.disconnect();
    });

    test('anti-AFK: el durmiente recibe aviso y se marca para que el host lo vea', async () => {
        const { host, guest, roomCode, guestName } = await createRoomWithGuest(server);

        const guestPlayer = server.rooms[roomCode].players.find(p => p.name === guestName);
        guestPlayer.lastSeen = Date.now() - AFK_WARN_MS - 1000;

        const afkWarn = waitFor(guest, 'afkWarning');
        const hostNotice = waitFor(host, 'roomNotice');
        server.sweepRooms();

        await Promise.all([afkWarn, hostNotice]);
        expect(guestPlayer.afkWarned).toBe(true);
        expect(server.rooms[roomCode].gameState).toBe('waiting'); // no se ha cerrado la sala

        host.disconnect();
        guest.disconnect();
    });
});