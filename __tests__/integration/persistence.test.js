const mysql = require('mysql2/promise');
const baseConfig = require('../../config');
const { bootTestServer, stopTestServer, connect, emitAndWait, registerUser } = require('./testServer');
const { getPlayableWords } = require('../../lib/game-logic');

jest.setTimeout(15000);

describe('persistencia en BD al terminar la partida', () => {
    let server;
    let dbPool;

    beforeAll(async () => {
        server = await bootTestServer();
        dbPool = await mysql.createPool({
            host: process.env.DB_HOST,
            user: baseConfig.user,
            password: baseConfig.password,
            database: process.env.DB_NAME
        });
    });

    afterAll(async () => {
        await dbPool.end();
        await stopTestServer(server);
    });

    test('un usuario registrado que gana una partida queda guardado en games/game_players/user_stats', async () => {
        const { username, token } = await registerUser(server.baseUrl);

        const socket = await connect(server.baseUrl);
        const [{ roomCode }] = await emitAndWait(
            socket, 'createRoom',
            { playerName: username, isPublic: false, totalRounds: 1, bonusesEnabled: false, sessionToken: token },
            ['playerToken', 'roomStateUpdate']
        );
        await emitAndWait(socket, 'startGame', undefined, 'roundStart');

        const letters = server.rooms[roomCode].currentLetters;
        const [word] = getPlayableWords(letters, { validWordsCache: server.validWordsCache });
        const wordResult = await emitAndWait(socket, 'submitWord', { word }, 'wordResult');
        expect(wordResult.valid).toBe(true);

        const [, gameOver] = await emitAndWait(socket, 'endRoundManual', undefined, ['roundEnd', 'gameOver']);
        expect(gameOver.winner.name).toBe(username);

        // endGame persiste de forma asíncrona tras emitir 'gameOver'; se
        // espera un poco a que termine el INSERT antes de consultar.
        await new Promise(r => setTimeout(r, 300));

        const [[user]] = await dbPool.query('SELECT id FROM users WHERE username = ?', [username]);
        expect(user).toBeTruthy();

        const [gamePlayers] = await dbPool.query(
            'SELECT gp.score, g.room_code FROM game_players gp JOIN games g ON g.id = gp.game_id WHERE gp.user_id = ?',
            [user.id]
        );
        expect(gamePlayers).toHaveLength(1);
        expect(gamePlayers[0].room_code).toBe(roomCode);
        expect(gamePlayers[0].score).toBe(wordResult.points);

        const [[stats]] = await dbPool.query('SELECT games_played, games_won, best_score FROM user_stats WHERE user_id = ?', [user.id]);
        expect(stats.games_played).toBe(1);
        expect(stats.games_won).toBe(1);
        expect(stats.best_score).toBe(wordResult.points);

        socket.disconnect();
    });
});
