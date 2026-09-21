const { bootTestServer, stopTestServer, connect, waitFor, emitAndWait, uniqueUsername } = require('./testServer');
const { getPlayableWords } = require('../../lib/game-logic');

jest.setTimeout(15000);

describe('reconexión (rejoinGame)', () => {
    let server;

    beforeAll(async () => { server = await bootTestServer(); });
    afterAll(async () => { await stopTestServer(server); });

    test('un jugador que se desconecta puede volver a la partida con su token', async () => {
        const first = await connect(server.baseUrl);
        const [{ roomCode, token }] = await emitAndWait(
            first, 'createRoom',
            { playerName: uniqueUsername('solo'), isPublic: false, totalRounds: 1, bonusesEnabled: false },
            ['playerToken', 'roomStateUpdate']
        );
        await emitAndWait(first, 'startGame', undefined, 'roundStart');

        const letters = server.rooms[roomCode].currentLetters;
        const [word] = getPlayableWords(letters, { validWordsCache: server.validWordsCache });
        const wordResult = await emitAndWait(first, 'submitWord', { word }, 'wordResult');
        expect(wordResult.valid).toBe(true);

        // Se cae la conexión: el server debe guardar el sitio (no borra la sala)
        first.disconnect();
        await new Promise(r => setTimeout(r, 200));
        expect(server.rooms[roomCode]).toBeTruthy();
        expect(server.rooms[roomCode].players[0].disconnected).toBe(true);

        const second = await connect(server.baseUrl);
        const [state, resumed] = await emitAndWait(
            second, 'rejoinGame', { roomCode, token },
            ['roomStateUpdate', 'roundStart']
        );
        // El estado que ve el cliente no lleva un campo `disconnected`: la
        // desconexión se representa con el prefijo "❌ " en el nombre, que
        // debe haber desaparecido al reanudar.
        expect(state.players[0].name).not.toMatch(/^❌/);
        expect(server.rooms[roomCode].players[0].disconnected).toBe(false);
        expect(resumed.rejoined).toBe(true);
        expect(resumed.words.map(w => w.word)).toContain(word);

        second.disconnect();
    });

    test('token equivocado no permite reanudar', async () => {
        const host = await connect(server.baseUrl);
        const [{ roomCode }] = await emitAndWait(
            host, 'createRoom',
            { playerName: uniqueUsername('host2'), isPublic: false, totalRounds: 1, bonusesEnabled: false },
            ['playerToken', 'roomStateUpdate']
        );
        await emitAndWait(host, 'startGame', undefined, 'roundStart');

        const intruder = await connect(server.baseUrl);
        const err = await emitAndWait(intruder, 'rejoinGame', { roomCode, token: 'token-que-no-existe' }, 'error');
        expect(err).toMatch(/no se pudo reanudar/i);

        host.disconnect();
        intruder.disconnect();
    });
});
