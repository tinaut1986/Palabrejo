const { bootTestServer, stopTestServer, connect, waitFor, emitAndWait, uniqueUsername } = require('./testServer');
const { getPlayableWords, normalizeForMatch } = require('../../lib/game-logic');

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

// Total de jugables de la ronda actual tal y como el server debe calcularlo:
// formas canonicas unicas de las palabras jugables de las letras del tablero.
function expectedPlayableCount(server, roomCode) {
    const letters = server.rooms[roomCode].currentLetters;
    return new Set(getPlayableWords(letters, { validWordsCache: server.validWordsCache }).map(w => normalizeForMatch(w))).size;
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

        // Issue #2: roundEnd lleva el progreso "X de Y" y gameOver el agregado
        expect(roundEnd.playableCount).toBe(expectedPlayableCount(server, roomCode));
        expect(roundEnd.playableCount).toBeGreaterThan(0);
        expect(roundEnd.results[0].foundCount).toBe(1);
        expect(roundEnd.results[0].wordsThisRound).toHaveLength(1);
        expect(gameOver.playableCount).toBe(roundEnd.playableCount);
        expect(gameOver.players[0].foundCount).toBe(1);

        host.disconnect();
    });

    test('progreso agregado: playableCount suma las jugables de cada ronda', async () => {
        const host = await connect(server.baseUrl);
        const [{ roomCode }] = await emitAndWait(
            host, 'createRoom',
            { playerName: uniqueUsername('host'), isPublic: false, totalRounds: 2, bonusesEnabled: false },
            ['playerToken', 'roomStateUpdate']
        );
        await emitAndWait(host, 'startGame', undefined, 'roundStart');

        await emitAndWait(host, 'submitWord', { word: pickWord(server, roomCode) }, 'wordResult');
        const roundEnd1 = await emitAndWait(host, 'endRoundManual', undefined, 'roundEnd');
        const expected1 = expectedPlayableCount(server, roomCode);
        expect(roundEnd1.playableCount).toBe(expected1);

        // La ronda 2 arranca sola tras el descanso de 5s: esperarla en vez de
        // dormir (waitFor admite tiempo extra, la cuenta son 5s exactos).
        await waitFor(host, 'roundStart', 7000);

        await emitAndWait(host, 'submitWord', { word: pickWord(server, roomCode) }, 'wordResult');
        const [roundEnd2, gameOver] = await emitAndWait(host, 'endRoundManual', undefined, ['roundEnd', 'gameOver']);

        expect(roundEnd2.playableCount).toBeGreaterThan(0);
        expect(gameOver.playableCount).toBe(expected1 + roundEnd2.playableCount);
        expect(gameOver.players[0].foundCount).toBe(2);

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
