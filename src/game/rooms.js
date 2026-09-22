// Ciclo de vida completo de una sala: crear/unir/salir, rondas, bonus en
// letras y fin de partida. Va todo en un solo módulo (issue #7, pasada 3) en
// vez del rooms.js/round.js separados que proponía el issue original: room
// y ronda se llaman constantemente entre sí (endRound dispara la siguiente
// ronda o el fin de partida, el bonus depende del estado de la ronda...) y
// separarlos habría creado una dependencia circular entre los dos ficheros.
//
// `rooms` se recibe por referencia (no por getter): es el mismo objeto en
// memoria que usan los handlers de socket, así que las mutaciones de aquí
// se ven allí sin más.
const {
    collectStaleRooms, collectIdlePlayers, HOST_REQUEST_TTL_MS
} = require('../../lib/room-health');

function createGameModule({ io, rooms, getDbPool, gameLogic }) {
    const {
        calculateScore, isPalabrejo, normalizeForMatch, getPlayableWords,
        selectPlayableLetters, MIN_LETTERS, MAX_LETTERS, DEFAULT_GAME_MODE,
        NEXT_GAME_DELAY_MS, PALABREJO_BONUS,
        BONUS_MIN_SPAWN_DELAY_MS, BONUS_MAX_SPAWN_DELAY_MS,
        BONUS_MIN_DURATION_MS, BONUS_MAX_DURATION_MS,
        rollBonus, validWordsCache
    } = gameLogic;

    function generateRoomCode() {
        let code;
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        do {
            code = '';
            for (let i = 0; i < 4; i++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
        } while (rooms[code]);
        return code;
    }

    function getRoomStateForClient(room) {
        return {
            code: room.code,
            players: room.players.map(p => ({
                id: p.id,
                name: p.name,
                score: p.score,
                wordsFound: p.wordsFound,
                isHost: p.isHost,
                isGuest: p.isGuest,
                wordsThisRound: Array.from(p.wordsThisRound || []),
                roundScore: Array.from(p.wordsThisRound || []).reduce((sum, w) => sum + (p.wordPoints?.[w] ?? calculateScore(w, room.currentLetters)), 0),
                afkWarned: !!p.afkWarned
            })),
            gameState: room.gameState,
            hostId: room.hostId,
            config: {
                maxPlayers: room.maxPlayers,
                totalRounds: room.totalRounds,
                roundTime: room.roundTime,
                isPublic: room.isPublic,
                gameMode: room.gameMode || DEFAULT_GAME_MODE,
                bonusesEnabled: room.bonusesEnabled !== false
            },
            currentRound: room.currentRound,
            totalRounds: room.totalRounds,
            letters: room.currentLetters
        };
    }

    function getPublicRooms() {
        return Object.values(rooms)
            .filter(room => room.isPublic && room.gameState === 'waiting')
            .map(room => ({
                code: room.code,
                playerCount: room.players.length,
                maxPlayers: room.maxPlayers,
                gameMode: room.gameMode || DEFAULT_GAME_MODE,
                players: room.players.map(p => p.name)
            }));
    }

    function broadcastPublicRooms() {
        io.emit('publicRoomsList', getPublicRooms());
    }

    function broadcastRoomState(roomCode) {
        io.to(roomCode).emit('roomStateUpdate', getRoomStateForClient(rooms[roomCode]));
    }

    function addPlayerToRoom(roomCode, playerId, playerName, isHost = false, isGuest = false, userId = null, resumeToken = null) {
        rooms[roomCode].players.push({
            id: playerId,
            name: playerName,
            score: 0,
            wordsFound: [],
            wordsThisRound: new Set(),
            wordPoints: {},
            totalWordsFound: 0,
            isHost,
            isGuest,
            userId,
            disconnected: false,
            resumeToken,
            lastSeen: Date.now(),
            afkWarned: false
        });
    }

    function findRoomBySocket(socketId) {
        for (const [code, room] of Object.entries(rooms)) {
            if (room.players.some(p => p.id === socketId)) return code;
        }
        return null;
    }

    // Saca al socket de cualquier sala en la que este. Un socket solo puede
    // pertenecer a una sala: si se queda en dos, findRoomBySocket devuelve la
    // primera que encuentra y las acciones acaban aplicandose a la sala
    // equivocada (empezar la partida, enviar palabras, etc.).
    // Semantica de "me voy": el jugador se elimina, al contrario que en una
    // desconexion, donde se le guarda el sitio un rato por si vuelve.
    function detachSocketFromRooms(socket) {
        for (const [roomCode, room] of Object.entries(rooms)) {
            if (!room.players.some(p => p.id === socket.id)) continue;

            socket.leave(roomCode);
            const wasHost = room.hostId === socket.id;
            const wasHostRequester = room.hostRequest?.requesterId === socket.id;
            room.players = room.players.filter(p => p.id !== socket.id);

            if (room.players.length === 0) {
                if (room.roundTimer) clearTimeout(room.roundTimer);
                if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
                if (room.restTimer) clearTimeout(room.restTimer);
                if (room.hostRequestTimer) clearTimeout(room.hostRequestTimer);
                clearBonusTimers(room);
                delete rooms[roomCode];
                if (room.isPublic) broadcastPublicRooms();
                continue;
            }

            // Una peticion de traspaso pendiente muere si se va su solicitante
            // o el propio host (ya no podria responder a ella).
            if (room.hostRequest && (wasHost || wasHostRequester)) {
                room.hostRequest = null;
                if (room.hostRequestTimer) { clearTimeout(room.hostRequestTimer); room.hostRequestTimer = null; }
            }

            if (wasHost) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
                io.to(roomCode).emit('roomNotice', { text: `${room.players[0].name} es el nuevo anfitrión.`, type: 'host' });
            }
            broadcastRoomState(roomCode);
            if (room.isPublic) broadcastPublicRooms();
        }
    }

    // A dropped connection no longer deletes an in-progress room instantly:
    // schedule a deletion only if nobody comes back within the grace period.
    const RESUME_GRACE_MS = 2 * 60 * 1000;

    function scheduleRoomCleanup(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
        room.cleanupTimer = setTimeout(() => {
            room.cleanupTimer = null;
            const alive = room.players.some(p => !p.disconnected);
            if (!alive) {
                if (room.roundTimer) clearTimeout(room.roundTimer);
                clearBonusTimers(room);
                delete rooms[roomCode];
            }
        }, RESUME_GRACE_MS);
    }

    function startRound(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        const letterCount = MIN_LETTERS + Math.floor(Math.random() * (MAX_LETTERS - MIN_LETTERS + 1));
        room.currentLetters = selectPlayableLetters(letterCount);
        room.roundEnded = false;
        room.roundEndsAt = Date.now() + room.roundTime * 1000;

        room.players.forEach(p => { p.wordsThisRound = new Set(); p.wordPoints = {}; });

        io.to(roomCode).emit('roundStart', {
            round: room.currentRound,
            totalRounds: room.totalRounds,
            letters: room.currentLetters,
            time: room.roundTime
        });
        broadcastRoomState(roomCode);

        room.roundTimer = setTimeout(() => endRound(roomCode), room.roundTime * 1000);

        clearBonusTimers(room);
        if (room.bonusesEnabled) scheduleBonusSpawn(roomCode);
    }

    // --- BONUS/CASTIGO EN EL TABLERO ---
    function clearBonusTimers(room) {
        if (room.bonusSpawnTimer) { clearTimeout(room.bonusSpawnTimer); room.bonusSpawnTimer = null; }
        if (room.bonusExpireTimer) { clearTimeout(room.bonusExpireTimer); room.bonusExpireTimer = null; }
        room.activeBonus = null;
    }

    // De vez en cuando, mientras la ronda esta en marcha, aparece un bonus o
    // castigo sobre una letra del tablero al azar. Solo hay uno activo a la
    // vez; si nadie lo usa antes de que caduque, desaparece y se programa el
    // siguiente.
    function scheduleBonusSpawn(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'playing') return;

        const delay = randomBetween(BONUS_MIN_SPAWN_DELAY_MS, BONUS_MAX_SPAWN_DELAY_MS);
        const timeLeft = room.roundEndsAt - Date.now();
        if (timeLeft <= delay + BONUS_MIN_DURATION_MS) return; // no cabe otra ronda de bonus

        room.bonusSpawnTimer = setTimeout(() => spawnBonus(roomCode), delay);
    }

    function randomBetween(min, max) {
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    function spawnBonus(roomCode) {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'playing' || room.activeBonus) return;
        if (!room.currentLetters || room.currentLetters.length === 0) return;

        const letter = room.currentLetters[Math.floor(Math.random() * room.currentLetters.length)];
        const bonus = rollBonus();
        const maxDuration = Math.max(BONUS_MIN_DURATION_MS, Math.min(BONUS_MAX_DURATION_MS, room.roundEndsAt - Date.now() - 1000));
        const duration = randomBetween(BONUS_MIN_DURATION_MS, maxDuration);

        room.activeBonus = { letter, ...bonus, expiresAt: Date.now() + duration };

        io.to(roomCode).emit('letterBonus', {
            letter,
            kind: bonus.kind,
            value: bonus.value,
            malus: bonus.malus,
            aggressive: bonus.aggressive,
            label: bonus.label,
            durationMs: duration
        });

        room.bonusExpireTimer = setTimeout(() => {
            const r = rooms[roomCode];
            if (!r || !r.activeBonus || r.activeBonus.letter !== letter) return;
            r.activeBonus = null;
            io.to(roomCode).emit('letterBonusExpired', { letter, reason: 'timeout' });
            scheduleBonusSpawn(roomCode);
        }, duration);
    }

    function endRound(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        if (room.roundEnded) return; // ignore double-triggers (timeout, manual spam)

        room.roundEnded = true;
        if (room.roundTimer) {
            clearTimeout(room.roundTimer);
            room.roundTimer = null;
        }
        clearBonusTimers(room);

        const roundResults = room.players.map(p => ({
            id: p.id,
            name: p.name,
            wordsThisRound: Array.from(p.wordsThisRound),
            scoreThisRound: Array.from(p.wordsThisRound).reduce((sum, w) => sum + (p.wordPoints?.[w] ?? calculateScore(w, room.currentLetters)), 0),
            totalScore: p.score,
            foundCount: p.wordsThisRound.size
        }));

        // Las palabras mas largas de la ronda, encontradas por quien sea: un
        // vistazo rapido a la mejor jugada, sin tener que leer todas las listas.
        const foundTally = {};
        room.players.forEach(p => {
            p.wordsThisRound.forEach(w => {
                if (!foundTally[w]) foundTally[w] = { word: w, players: [] };
                foundTally[w].players.push(p.name);
            });
        });
        const topWords = Object.values(foundTally)
            .sort((a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word))
            .slice(0, 5);

        // Total de palabras jugables de este tablero. Se saca del MISMO
        // recorrido de getPlayableWords (sin una segunda pasada por las ~108k
        // entradas del diccionario) contando la forma canonica unica: asi
        // coincide con lo que el server considera jugable para desempatar
        // duplicados ("canto"/"cantó" son la misma palabra para el jugador).
        const playable = getPlayableWords(room.currentLetters, { validWordsCache });
        const playableCount = new Set(playable.map(w => normalizeForMatch(w))).size;
        room.totalPlayable = (room.totalPlayable || 0) + playableCount;

        io.to(roomCode).emit('roundEnd', {
            round: room.currentRound,
            results: roundResults,
            letters: room.currentLetters,
            topWords,
            playableCount
        });

        // Las que se le escaparon a cada uno: personal, solo para quien no las
        // encontro (no tiene gracia que el resto vea lo que a ti te faltó).
        room.players.forEach(p => {
            const missed = playable
                .filter(w => !p.wordsThisRound.has(normalizeForMatch(w)))
                .sort((a, b) => b.length - a.length || a.localeCompare(b))
                .slice(0, 8);
            io.to(p.id).emit('roundMissedWords', { round: room.currentRound, words: missed });
        });

        if (room.currentRound >= room.totalRounds) {
            endGame(roomCode);
        } else {
            room.currentRound++;
            setTimeout(() => startRound(roomCode), 5000);
        }
    }

    async function endGame(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        room.gameState = 'rest';

        const sorted = [...room.players].sort((a, b) => b.score - a.score);
        const winner = sorted[0];

        // Las mas repetidas (por distintos jugadores o en distintas rondas) y
        // las mas largas de toda la partida, igual que al terminar una ronda
        // pero sumando todo el juego.
        const tally = {};
        room.players.forEach(p => {
            p.wordsFound.forEach(w => {
                const key = normalizeForMatch(w);
                if (!tally[key]) tally[key] = { word: w, count: 0, players: [] };
                tally[key].count++;
                tally[key].players.push(p.name);
            });
        });
        const allWords = Object.values(tally);
        const mostFound = allWords
            .filter(t => t.count > 1)
            .sort((a, b) => b.count - a.count || b.word.length - a.word.length)
            .slice(0, 5);
        const longestWords = [...allWords]
            .sort((a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word))
            .slice(0, 5);

        io.to(roomCode).emit('gameOver', {
            winner: { id: winner.id, name: winner.name, score: winner.score },
            players: sorted.map(p => ({
                id: p.id,
                name: p.name,
                score: p.score,
                wordsFound: p.wordsFound,
                foundCount: p.totalWordsFound
            })),
            // Progreso agregado de toda la partida: suma de las jugables de
            // cada ronda, contra las palabras (en total) que encontro cada uno.
            playableCount: room.totalPlayable || 0,
            mostFound,
            longestWords
        });

        // Persist to DB for registered users
        try {
            const dbPool = getDbPool();
            const [gameResult] = await dbPool.query(
                'INSERT INTO games (room_code, host_user_id, max_players, total_rounds, letters_used) VALUES (?, ?, ?, ?, ?)',
                [room.code, room.players.find(p => p.isHost)?.userId || null, room.maxPlayers, room.totalRounds, room.currentLetters.join('')]
            );
            const gameId = gameResult.insertId;

            for (const p of room.players) {
                if (p.userId) {
                    await dbPool.query(
                        'INSERT INTO game_players (game_id, user_id, score, words_found) VALUES (?, ?, ?, ?)',
                        [gameId, p.userId, p.score, JSON.stringify(p.wordsFound)]
                    );

                    const isWinner = p.id === winner.id;
                    await dbPool.query(`
                        INSERT INTO user_stats (user_id, games_played, games_won, total_words, total_score, best_score)
                        VALUES (?, 1, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            games_played = games_played + 1,
                            games_won = games_won + VALUES(games_won),
                            total_words = total_words + VALUES(total_words),
                            total_score = total_score + VALUES(total_score),
                            best_score = GREATEST(best_score, VALUES(best_score))
                    `, [p.userId, isWinner ? 1 : 0, p.wordsFound.length, p.score, p.score]);
                }
            }
        } catch (error) {
            console.error("Error persisting game results:", error);
        }

        // Descanso y arranque automatico de una partida nueva con la misma
        // gente y las mismas condiciones, mientras queden jugadores en la sala.
        room.restEndsAt = Date.now() + NEXT_GAME_DELAY_MS;
        room.restTimer = setTimeout(() => startNewGame(roomCode), NEXT_GAME_DELAY_MS);

        io.to(roomCode).emit('restStart', {
            delay: NEXT_GAME_DELAY_MS,
            roundTime: room.roundTime,
            totalRounds: room.totalRounds
        });
    }

    // Mantenimiento periodico de la salud de salas (issue #15). Lo llama un
    // setInterval del server (~1 min): elimina las salas waiting huerfanas y
    // avisa a los jugadores inactivos de las que siguen vivas. Devuelve un
    // resumen {swept, warned} para tests/logs.
    function sweepRooms(now = Date.now()) {
        const swept = [];

        for (const code of collectStaleRooms(rooms, now)) {
            const room = rooms[code];
            if (!room) continue;
            swept.push(code);
            if (room.hostRequestTimer) { clearTimeout(room.hostRequestTimer); room.hostRequestTimer = null; }
            clearBonusTimers(room);

            room.players.forEach(p => {
                const sock = io.sockets.sockets.get(p.id);
                if (sock) {
                    sock.emit('roomClosed', 'La sala de espera se ha cerrado por inactividad.');
                    sock.leave(code);
                }
            });
            delete rooms[code];
            if (room.isPublic) broadcastPublicRooms();
        }

        const warned = [];
        for (const [code, room] of Object.entries(rooms)) {
            if (!room || room.gameState !== 'waiting') continue;
            for (const p of collectIdlePlayers(room, now)) {
                p.afkWarned = true;
                const sock = io.sockets.sockets.get(p.id);
                if (sock) sock.emit('afkWarning', {});
                io.to(code).emit('roomNotice', { text: `${p.name} lleva un rato sin responder.`, type: 'afk' });
                warned.push(code);
            }
        }

        return { swept, warned };
    }

    // Arranca una partida nueva en la misma sala, con las mismas condiciones y
    // los jugadores que sigan dentro tras el descanso. Vacia el marcador y las
    // listas de palabras para que la partida empiece de cero.
    function startNewGame(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        room.restTimer = null;
        room.restEndsAt = 0;

        // Si ya no queda nadie en sala durante el descanso, se cierra la partida.
        if (!room.players.some(p => !p.disconnected)) {
            if (room.roundTimer) clearTimeout(room.roundTimer);
            if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
            delete rooms[roomCode];
            if (room.isPublic) broadcastPublicRooms();
            return;
        }

        room.gameState = 'playing';
        room.currentRound = 1;
        room.usedWords = {};
        room.totalPlayable = 0;
        room.players.forEach(p => {
            p.score = 0;
            p.totalWordsFound = 0;
            p.wordsFound = [];
            p.wordsThisRound = new Set();
            p.wordPoints = {};
        });

        startRound(roomCode);
    }

    return {
        generateRoomCode,
        addPlayerToRoom,
        findRoomBySocket,
        detachSocketFromRooms,
        scheduleRoomCleanup,
        RESUME_GRACE_MS,
        getRoomStateForClient,
        getPublicRooms,
        broadcastPublicRooms,
        broadcastRoomState,
        startRound,
        endRound,
        endGame,
        startNewGame,
        sweepRooms,
        spawnBonus,
        scheduleBonusSpawn,
        clearBonusTimers
    };
}

module.exports = { createGameModule };
