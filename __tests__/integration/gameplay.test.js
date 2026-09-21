const { bootTestServer, stopTestServer, connect, waitFor, emitAndWait, uniqueUsername } = require('./testServer');
const { getPlayableWords } = require('../../lib/game-logic');

jest.setTimeout(15000);

// Palabra jugable para el tablero actual: se calcula contra el diccionario
// real ya cargado en memoria por el server (no se hardcodea ninguna palabra,
// las letras salen distintas en cada partida).
function pickWord(server, roomCode, { minLength = 3 } = {}) {
    const letters = server.rooms[roomCode].currentLetters;
    const words = getPlayableWords(letters, { validWordsCache: server.validWordsCache, minLength });
    if (!words.length) throw new Error('sin palabras jugables en este tablero (no deberia pasar)');
    return words.sort((a, b) => b.length - a.length)[0];
}

async function createAndStart(server, { totalRounds = 1, gameMode = 'normal' } = {}) {
    const host = await connect(server.baseUrl);
    const [{ roomCode }] = await emitAndWait(
        host, 'createRoom',
        { playerName: uniqueUsername('host'), isPublic: false, totalRounds, gameMode, bonusesEnabled: false },
        ['playerToken', 'roomStateUpdate']
    );

    const guest = await connect(server.baseUrl);
    const hostSeesJoin = waitFor(host, 'roomStateUpdate');
    await emitAndWait(guest, 'joinRoom', { roomCode, playerName: uniqueUsername('guest') }, 'playerToken');
    await hostSeesJoin;

    // Los dos escuchan 'roundStart' ANTES de pedir que empiece la partida:
    // llega a ambos casi a la vez y si se esperase uno detras del otro el
    // segundo podria perderse el evento (ya disparado, sin listener aun).
    const hostRoundStart = waitFor(host, 'roundStart');
    const guestRoundStart = waitFor(guest, 'roundStart');
    host.emit('startGame');
    await Promise.all([hostRoundStart, guestRoundStart]);
    return { host, guest, roomCode };
}

describe('partida completa', () => {
    let server;

    beforeAll(async () => { server = await bootTestServer(); });
    afterAll(async () => { await stopTestServer(server); });

    test('palabra válida puntúa, repetirla da duplicate, y termina la ronda/partida', async () => {
        const host = await connect(server.baseUrl);
        const [{ roomCode }] = await emitAndWait(
            host, 'createRoom',
            { playerName: uniqueUsername('host'), isPublic: false, totalRounds: 1, bonusesEnabled: false },
            ['playerToken', 'roomStateUpdate']
        );
        await emitAndWait(host, 'startGame', undefined, 'roundStart');

        const word = pickWord(server, roomCode);

        const result = await emitAndWait(host, 'submitWord', { word }, 'wordResult');
        expect(result.valid).toBe(true);
        expect(result.points).toBeGreaterThan(0);

        const dup = await emitAndWait(host, 'submitWord', { word }, 'wordResult');
        expect(dup.valid).toBe(false);
        expect(dup.reason).toBe('duplicate');

        const invalid = await emitAndWait(host, 'submitWord', { word: 'zzqxw' }, 'wordResult'); // no es una palabra real
        expect(invalid.valid).toBe(false);
        expect(invalid.reason).toBe('invalid');

        const [roundEnd, gameOver] = await emitAndWait(host, 'endRoundManual', undefined, ['roundEnd', 'gameOver']);
        expect(roundEnd.results[0].scoreThisRound).toBe(result.points);
        expect(gameOver.winner.score).toBe(result.points);

        host.disconnect();
    });

    test('modo exclusivo: solo la primera puntua, la segunda se rechaza', async () => {
        const { host, guest, roomCode } = await createAndStart(server, { gameMode: 'exclusivo' });
        const word = pickWord(server, roomCode);

        const first = await emitAndWait(host, 'submitWord', { word }, 'wordResult');
        expect(first.valid).toBe(true);

        const second = await emitAndWait(guest, 'submitWord', { word }, 'wordResult');
        expect(second.valid).toBe(false);
        expect(second.reason).toBe('used_by_other');

        host.disconnect();
        guest.disconnect();
    });

    test('modo normal: los dos jugadores puntúan la misma palabra', async () => {
        const { host, guest, roomCode } = await createAndStart(server, { gameMode: 'normal' });
        const word = pickWord(server, roomCode);

        const first = await emitAndWait(host, 'submitWord', { word }, 'wordResult');
        expect(first.valid).toBe(true);

        const second = await emitAndWait(guest, 'submitWord', { word }, 'wordResult');
        expect(second.valid).toBe(true);
        expect(second.points).toBe(first.points);

        host.disconnect();
        guest.disconnect();
    });
});
