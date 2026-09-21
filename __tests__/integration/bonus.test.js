const { bootTestServer, stopTestServer, connect, waitFor, emitAndWait, uniqueUsername } = require('./testServer');
const { getPlayableWords, normalizeForMatch, calculateScore } = require('../../lib/game-logic');

jest.setTimeout(20000);

// El bonus se coloca sobre una letra al azar en un momento al azar (6-14s):
// esperar eso de verdad haría el test lento y flaky. En su lugar se inyecta
// el estado directamente en `rooms` (expuesto por server.js para tests) y se
// ejerce el mismo camino real de submitWord que usaría un spawn de verdad.
function forceBonus(server, roomCode, bonus) {
    server.rooms[roomCode].activeBonus = { expiresAt: Date.now() + 5000, ...bonus };
}

async function createAndStart(server, opts = {}) {
    const host = await connect(server.baseUrl);
    const [{ roomCode }] = await emitAndWait(
        host, 'createRoom',
        { playerName: uniqueUsername('host'), isPublic: false, totalRounds: 1, bonusesEnabled: true, ...opts },
        ['playerToken', 'roomStateUpdate']
    );

    const guest = await connect(server.baseUrl);
    const hostSeesJoin = waitFor(host, 'roomStateUpdate');
    await emitAndWait(guest, 'joinRoom', { roomCode, playerName: uniqueUsername('guest') }, 'playerToken');
    await hostSeesJoin;

    const hostRoundStart = waitFor(host, 'roundStart');
    const guestRoundStart = waitFor(guest, 'roundStart');
    host.emit('startGame');
    await Promise.all([hostRoundStart, guestRoundStart]);
    return { host, guest, roomCode };
}

function wordUsingLetter(server, roomCode, letter) {
    const letters = server.rooms[roomCode].currentLetters;
    const words = getPlayableWords(letters, { validWordsCache: server.validWordsCache });
    return words.find(w => normalizeForMatch(w).includes(normalizeForMatch(letter)));
}

describe('bonus/castigo en letras del tablero', () => {
    let server;

    beforeAll(async () => { server = await bootTestServer(); });
    afterAll(async () => { await stopTestServer(server); });

    test('multiplicador (x2) se aplica y se consume con la primera palabra que usa la letra', async () => {
        const { host, guest, roomCode } = await createAndStart(server);
        const letter = server.rooms[roomCode].currentLetters[0];
        const word = wordUsingLetter(server, roomCode, letter);
        if (!word) return; // tablero sin palabra con esa letra concreta: no aplica

        forceBonus(server, roomCode, { letter, kind: 'multiply', value: 2, malus: false, aggressive: false, label: 'x2' });

        const result = await emitAndWait(host, 'submitWord', { word }, 'wordResult');
        const base = calculateScore(word, server.rooms[roomCode].currentLetters);
        expect(result.bonusApplied).toBeTruthy();
        expect(result.bonusApplied.kind).toBe('multiply');
        expect(result.points).toBe(base * 2);

        // Consumido: ya no deberia quedar activo para el siguiente
        expect(server.rooms[roomCode].activeBonus).toBeNull();

        host.disconnect();
        guest.disconnect();
    });

    test('robo: suma a quien la usa y resta al lider de la ronda', async () => {
        const { host, guest, roomCode } = await createAndStart(server);
        const room = server.rooms[roomCode];
        const hostPlayer = room.players.find(p => p.name.startsWith('host'));
        const guestPlayer = room.players.find(p => p.name.startsWith('guest'));

        // El host va primero en la ronda: le da puntaje de partida al guest para
        // que sea el "lider" al que se le roba.
        guestPlayer.score = 100;
        hostPlayer.score = 10;

        const letter = room.currentLetters[0];
        const word = wordUsingLetter(server, roomCode, letter);
        if (!word) return;

        forceBonus(server, roomCode, { letter, kind: 'steal', value: 8, malus: false, aggressive: true, label: 'robo 8' });

        const [result, stolenEvent] = await emitAndWait(host, 'submitWord', { word }, ['wordResult', 'bonusStolen']);
        expect(result.bonusApplied.kind).toBe('steal');
        expect(stolenEvent.to).toBe(hostPlayer.name);
        expect(stolenEvent.from).toBe(guestPlayer.name);
        expect(guestPlayer.score).toBe(92); // 100 - 8

        host.disconnect();
        guest.disconnect();
    });

    test('un bonus real (spawn) expira solo si nadie lo usa', async () => {
        const { host, guest, roomCode } = await createAndStart(server);

        const spawned = waitFor(host, 'letterBonus');
        server.spawnBonus(roomCode); // dispara el spawn real, sin esperar el retraso aleatorio
        const bonus = await spawned;
        expect(bonus.letter).toBeTruthy();
        expect(bonus.durationMs).toBeGreaterThan(0);

        const expired = await waitFor(host, 'letterBonusExpired', bonus.durationMs + 3000);
        expect(expired.letter).toBe(bonus.letter);
        expect(expired.reason).toBe('timeout');
        expect(server.rooms[roomCode].activeBonus).toBeNull();

        host.disconnect();
        guest.disconnect();
    });
});
