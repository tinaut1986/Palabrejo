// Registro de los eventos de socket.io. Toda la logica de sala/ronda vive en
// src/game/rooms.js (`game`); esto solo valida la peticion, la traduce a
// llamadas a `game` y contesta al cliente.
function registerSocketHandlers({
    io, rooms, game, crypto,
    resolvePlayer, emitSessionExpired,
    normalizeForMatch, isWordValid, calculateScore, isPalabrejo, applyBonus,
    PALABREJO_BONUS, MIN_WORD_LENGTH, DEFAULT_MAX_PLAYERS, DEFAULT_ROUNDS,
    DEFAULT_ROUND_TIME, normalizeGameMode,
    socketFloodLimiter, SOCKET_EVENTS_PER_SECOND,
    wordSubmitLimiter, WORD_SUBMIT_LIMIT_PER_SECOND
}) {
    const { HOST_REQUEST_TTL_MS } = require('../../lib/room-health');

    // Cualquier evento de un jugador cuenta como "actividad": refresca su
    // lastSeen (para el anti-AFK de la sala de espera) y, si es el host, la
    // actividad de la sala (mantiene viva la waiting para el sweep).
    function touchActivity(socketId) {
        const roomCode = game.findRoomBySocket(socketId);
        if (!roomCode) return;
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socketId);
        if (player) {
            player.lastSeen = Date.now();
            player.afkWarned = false;
        }
        if (room.hostId === socketId) room.lastHostActivity = Date.now();
    }

    io.on('connection', (socket) => {
        console.log(`Connected: ${socket.id}`);

        // Frena a un cliente (o script) que dispara eventos de socket sin
        // parar: por encima de esto ya no es un jugador humano tecleando/tocando.
        // De paso refresta si el jugador sigue activo (issue #15).
        socket.onAny(() => {
            touchActivity(socket.id);
            if (socketFloodLimiter.hit(socket.id) > SOCKET_EVENTS_PER_SECOND) {
                socket.disconnect(true);
            }
        });

        socket.on('createRoom', async ({ playerName, isPublic, maxPlayers, totalRounds, roundTime, gameMode, bonusesEnabled, sessionToken }) => {
            const player = await resolvePlayer(sessionToken, playerName);
            if (player.expired) return emitSessionExpired(socket);
            if (player.error) return socket.emit('error', player.error);

            game.detachSocketFromRooms(socket);

            const roomCode = game.generateRoomCode();
            const clampedMax = Math.min(Math.max(maxPlayers || DEFAULT_MAX_PLAYERS, 2), 12);
            const clampedRounds = Math.min(Math.max(totalRounds || DEFAULT_ROUNDS, 1), 15);
            const clampedTime = Math.min(Math.max(roundTime || DEFAULT_ROUND_TIME, 30), 180);
            const mode = normalizeGameMode(gameMode);

            rooms[roomCode] = {
                code: roomCode,
                players: [],
                gameState: 'waiting',
                hostId: socket.id,
                isPublic: isPublic !== false,
                maxPlayers: clampedMax,
                totalRounds: clampedRounds,
                roundTime: clampedTime,
                gameMode: mode,
                bonusesEnabled: bonusesEnabled !== false,
                currentRound: 0,
                currentLetters: [],
                roundTimer: null,
                roundEndsAt: 0,
                roundEnded: false,
                usedWords: {},
                cleanupTimer: null,
                restTimer: null,
                restEndsAt: 0,
                activeBonus: null,
                bonusSpawnTimer: null,
                bonusExpireTimer: null,
                hostRequest: null,
                hostRequestTimer: null,
                createdAt: Date.now(),
                lastHostActivity: Date.now()
            };

            const token = crypto.randomBytes(16).toString('hex');
            game.addPlayerToRoom(roomCode, socket.id, player.name, true, !player.userId, player.userId, token);
            socket.join(roomCode);
            socket.emit('playerToken', { roomCode, token });

            game.broadcastRoomState(roomCode);
            if (rooms[roomCode].isPublic) game.broadcastPublicRooms();
        });

        // El cliente avisa al volver al hall, en lugar de dejar el socket dentro
        socket.on('leaveRoom', () => {
            game.detachSocketFromRooms(socket);
        });

        socket.on('getPublicRooms', () => {
            socket.emit('publicRoomsList', game.getPublicRooms());
        });

        // El host expulsa a un jugador de la sala en espera (issue #15): un
        // dormido ocupa la plaza de un max de 12. Solo waiting y solo el host;
        // el expulsado vuelve al hall sin opcion de reanudar.
        socket.on('kickPlayer', ({ targetId } = {}) => {
            const roomCode = game.findRoomBySocket(socket.id);
            if (!roomCode) return;
            const room = rooms[roomCode];
            if (!room || room.gameState !== 'waiting') return;
            if (room.hostId !== socket.id) return;
            if (!targetId || targetId === socket.id) return;

            const target = room.players.find(p => p.id === targetId);
            if (!target) return;
            const targetName = target.name;

            room.players = room.players.filter(p => p.id !== targetId);
            if (room.hostRequest?.requesterId === targetId) {
                room.hostRequest = null;
                if (room.hostRequestTimer) { clearTimeout(room.hostRequestTimer); room.hostRequestTimer = null; }
            }

            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                targetSocket.leave(roomCode);
                targetSocket.emit('kicked', 'El anfitrión te ha expulsado de la sala.');
            }

            game.broadcastRoomState(roomCode);
            if (room.isPublic) game.broadcastPublicRooms();
            io.to(roomCode).emit('roomNotice', { text: `${targetName} ha sido expulsado de la sala.`, type: 'kick' });
        });

        // Pedir el rol de anfitrion cuando el host no responde o ha dejado la
        // sala abierta (issue #15). La peticion pide permiso al host actual;
        // si no responde, caduca y la sala huerfana la cierra el sweep.
        socket.on('becomeHost', () => {
            const roomCode = game.findRoomBySocket(socket.id);
            if (!roomCode) return;
            const room = rooms[roomCode];
            if (!room || room.gameState !== 'waiting') return;
            if (room.hostId === socket.id) return;
            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;
            if (room.hostRequest) return;

            const hostSocket = io.sockets.sockets.get(room.hostId);
            if (!hostSocket) {
                return socket.emit('roomNotice', { text: 'El anfitrión no está conectado. Prueba más tarde.', type: 'info' });
            }

            const requestId = crypto.randomBytes(8).toString('hex');
            room.hostRequest = { requestId, requesterId: socket.id, requesterName: player.name };
            hostSocket.emit('becomeHostRequest', { requestId, requesterName: player.name });

            room.hostRequestTimer = setTimeout(() => {
                const r = rooms[roomCode];
                if (!r || r.hostRequest?.requestId !== requestId) return;
                r.hostRequest = null;
                r.hostRequestTimer = null;
                const requester = io.sockets.sockets.get(socket.id);
                if (requester) {
                    requester.emit('roomNotice', { text: 'El anfitrión no ha respondido a tu petición.', type: 'info' });
                }
            }, HOST_REQUEST_TTL_MS);
        });

        // El host contesta a una peticion de convertirse en anfitrion: aprobar
        // lo traspasa (y se avisa a la sala), rechazar lo anula.
        socket.on('respondHostRequest', ({ requestId, approve } = {}) => {
            const roomCode = game.findRoomBySocket(socket.id);
            if (!roomCode) return;
            const room = rooms[roomCode];
            if (!room || room.hostId !== socket.id) return;
            if (!room.hostRequest || room.hostRequest.requestId !== requestId) return;

            const request = room.hostRequest;
            room.hostRequest = null;
            if (room.hostRequestTimer) { clearTimeout(room.hostRequestTimer); room.hostRequestTimer = null; }

            const requester = room.players.find(p => p.id === request.requesterId);
            if (approve && requester) {
                const oldHost = room.players.find(p => p.id === room.hostId);
                if (oldHost) oldHost.isHost = false;
                requester.isHost = true;
                room.hostId = requester.id;
                io.to(roomCode).emit('roomNotice', { text: `${requester.name} es el nuevo anfitrión.`, type: 'host' });
            } else if (requester) {
                const requesterSocket = io.sockets.sockets.get(request.requesterId);
                if (requesterSocket) {
                    requesterSocket.emit('roomNotice', { text: 'El anfitrión ha rechazado tu petición.', type: 'info' });
                }
            }

            game.broadcastRoomState(roomCode);
            if (room.isPublic) game.broadcastPublicRooms();
        });

        socket.on('joinRoom', async ({ roomCode, playerName, sessionToken }) => {
            const room = rooms[roomCode];
            if (!room) return socket.emit('error', 'La sala no existe.');
            if (room.gameState !== 'waiting') return socket.emit('error', 'La partida ya ha comenzado.');
            if (room.players.length >= room.maxPlayers) return socket.emit('error', 'La sala está llena.');

            const player = await resolvePlayer(sessionToken, playerName);
            if (player.expired) return emitSessionExpired(socket);
            if (player.error) return socket.emit('error', player.error);

            game.detachSocketFromRooms(socket);

            const token = crypto.randomBytes(16).toString('hex');
            game.addPlayerToRoom(roomCode, socket.id, player.name, false, !player.userId, player.userId, token);
            socket.join(roomCode);
            socket.emit('playerToken', { roomCode, token });

            game.broadcastRoomState(roomCode);
            if (room.isPublic) game.broadcastPublicRooms();
        });

        // A player whose connection dropped can rejoin their in-progress game with
        // the token given at join time. The socket.id is swapped (reconnect gives a
        // new socket) and the round state is re-pushed so the UI resumes live.
        socket.on('rejoinGame', ({ roomCode, token }) => {
            const room = rooms[roomCode];
            if (!room) return socket.emit('error', 'La sala ya no existe.');
            const player = room.players.find(p => p.resumeToken === token);
            if (!player) return socket.emit('error', 'No se pudo reanudar la sala.');

            // Cancel any pending room cleanup scheduled by the disconnect.
            if (room.cleanupTimer) {
                clearTimeout(room.cleanupTimer);
                room.cleanupTimer = null;
            }

            // If the old socket is still known (e.g. a duplicate tab), leave it.
            const oldSocketId = player.id;
            if (oldSocketId !== socket.id) {
                const oldPlayerIndex = room.players.findIndex(p => p.id === socket.id);
                if (oldPlayerIndex !== -1) room.players.splice(oldPlayerIndex, 1);
            }

            player.id = socket.id;
            player.disconnected = false;
            player.name = player.name.replace(/^❌ /, '');
            socket.join(roomCode);

            // El socket.id cambia al reconectar: sin esto el host que vuelve
            // conservaba la insignia pero perdia sus permisos
            if (player.isHost) room.hostId = socket.id;

            if (room.gameState !== 'waiting' && room.gameState !== 'playing' && room.gameState !== 'rest') {
                socket.emit('error', 'La partida ya ha terminado.');
                return;
            }

            // El estado de la sala va PRIMERO: 'roundStart' se pinta contando con
            // que el cliente ya conoce la sala (rondas, jugadores, marcador).
            game.broadcastRoomState(roomCode);

            if (room.gameState === 'playing') {
                socket.emit('roundStart', {
                    round: room.currentRound,
                    totalRounds: room.totalRounds,
                    letters: room.currentLetters,
                    time: Math.max(1, Math.ceil((room.roundEndsAt - Date.now()) / 1000)),
                    rejoined: true,
                    // Palabras ya acertadas en esta ronda, para repoblar la lista
                    words: Array.from(player.wordsThisRound).map(w => ({
                        word: w,
                        points: player.wordPoints?.[w] ?? calculateScore(w, room.currentLetters),
                        palabrejo: isPalabrejo(w, room.currentLetters)
                    }))
                });
            }
            if (room.gameState === 'rest' && room.restTimer) {
                // Quien vuelve durante el descanso recupera la cuenta atras hacia
                // la siguiente partida, con el tiempo restante real.
                socket.emit('restStart', { delay: Math.max(1000, room.restEndsAt - Date.now()) });
            }
            if (room.isPublic) game.broadcastPublicRooms();
        });

        socket.on('startGame', () => {
            const roomCode = game.findRoomBySocket(socket.id);
            if (!roomCode) return;
            const room = rooms[roomCode];
            if (!room || room.hostId !== socket.id) return;
            if (room.players.length < 1) return socket.emit('error', 'No hay jugadores en la sala.');

            // A single player can start too (modo solitario)
            room.gameState = 'playing';
            room.currentRound = 1;
            room.usedWords = {};
            room.totalPlayable = 0;
            room.players.forEach(p => { p.score = 0; p.totalWordsFound = 0; });

            game.startRound(roomCode);
        });

        socket.on('submitWord', (payload) => {
            // Lo que llega por el socket puede ser cualquier cosa: sin este filtro,
            // un cliente cualquiera tumba el servidor mandando algo que no sea texto
            const word = typeof payload?.word === 'string' ? payload.word : null;
            if (!word) return;

            const roomCode = game.findRoomBySocket(socket.id);
            if (!roomCode) return;
            const room = rooms[roomCode];
            if (!room || room.gameState !== 'playing') return;

            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;

            const cleanWord = word.trim().toLowerCase();
            if (cleanWord.length < MIN_WORD_LENGTH) return;

            // Por encima de esto ya no es alguien jugando: se descarta sin
            // validar (ni contra diccionario ni contra duplicados) para no
            // regalar trabajo pesado a un cliente que abusa.
            if (wordSubmitLimiter.hit(socket.id) > WORD_SUBMIT_LIMIT_PER_SECOND) {
                return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'throttled', points: 0 });
            }

            // Words with/without accents are the same word for duplicate purposes
            // (ñ stays distinct). Words found are kept as typed for display.
            const wordKey = normalizeForMatch(cleanWord);
            if (player.wordsThisRound.has(wordKey)) {
                return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'duplicate', points: 0 });
            }

            if (!isWordValid(cleanWord, room.currentLetters)) {
                return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'invalid', points: 0 });
            }

            // En modo exclusivo la palabra se la queda quien la manda primero; en
            // el normal cada jugador va a lo suyo y todos pueden encontrarla.
            if (room.gameMode === 'exclusivo') {
                const roundKey = `${roomCode}_r${room.currentRound}`;
                if (!room.usedWords[roundKey]) room.usedWords[roundKey] = new Set();
                if (room.usedWords[roundKey].has(wordKey)) {
                    return socket.emit('wordResult', { word: cleanWord, valid: false, reason: 'used_by_other', points: 0 });
                }
                room.usedWords[roundKey].add(wordKey);
            }
            player.wordsThisRound.add(wordKey);
            player.wordsFound.push(cleanWord);

            const palabrejo = isPalabrejo(cleanWord, room.currentLetters);
            const basePoints = calculateScore(cleanWord, room.currentLetters);

            // Si la palabra usa la letra con bonus/castigo activo, se consume
            // aqui: solo el primero en jugarla se lleva el efecto.
            let points = basePoints;
            let bonusApplied = null;
            const bonus = room.activeBonus;
            if (bonus && normalizeForMatch(cleanWord).includes(normalizeForMatch(bonus.letter))) {
                points = applyBonus(basePoints, bonus);
                bonusApplied = { letter: bonus.letter, kind: bonus.kind, value: bonus.value, malus: bonus.malus, label: bonus.label };

                if (room.bonusExpireTimer) { clearTimeout(room.bonusExpireTimer); room.bonusExpireTimer = null; }
                room.activeBonus = null;
                io.to(roomCode).emit('letterBonusExpired', { letter: bonus.letter, reason: 'used', playerName: player.name, kind: bonus.kind, label: bonus.label });
                game.scheduleBonusSpawn(roomCode);

                if (bonus.kind === 'steal') {
                    const target = room.players
                        .filter(p => p.id !== player.id)
                        .sort((a, b) => b.score - a.score)[0];
                    if (target) {
                        target.score = Math.max(0, target.score - bonus.value);
                        io.to(roomCode).emit('bonusStolen', { from: target.name, to: player.name, amount: bonus.value });
                    }
                }
            }

            player.wordPoints[wordKey] = points;
            player.score += points;
            player.totalWordsFound++;

            socket.emit('wordResult', { word: cleanWord, valid: true, reason: 'ok', points, basePoints, palabrejo, bonusApplied });
            // El PALABREJO es la jugada de la ronda y se anuncia a la sala, pero
            // sin decir cual es: que cada cual la busque por su cuenta.
            if (palabrejo) {
                io.to(roomCode).emit('palabrejo', { playerName: player.name, bonus: PALABREJO_BONUS });
            }
            game.broadcastRoomState(roomCode);
        });

        socket.on('endRoundManual', () => {
            const roomCode = game.findRoomBySocket(socket.id);
            if (!roomCode) return;
            const room = rooms[roomCode];
            if (!room || room.hostId !== socket.id) return;
            game.endRound(roomCode);
        });

        // Safety net: when a player's countdown hits 0 the client asks the server
        // to end the round. The server timer is authoritative; this event only
        // helps if it did not fire (and it is restricted to the final 2 seconds).
        socket.on('roundTimeout', () => {
            const roomCode = game.findRoomBySocket(socket.id);
            if (!roomCode) return;
            const room = rooms[roomCode];
            if (!room || room.gameState !== 'playing') return;
            if (Date.now() >= room.roundEndsAt - 2000) game.endRound(roomCode);
        });

        socket.on('disconnect', () => {
            const roomCode = game.findRoomBySocket(socket.id);
            if (!roomCode) return;
            const room = rooms[roomCode];
            if (!room) return;

            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;

            if (room.gameState === 'waiting') {
                // Antes de empezar no hay nada que guardar: se le saca de la sala
                game.detachSocketFromRooms(socket);
            } else if (room.gameState !== 'finished') {
                // In-progress game: keep the room alive for a grace period so a
                // transient connection drop (mobile wifi, etc.) does not kill the
                // whole match. The player can rejoin with their resume token.
                player.name = `❌ ${player.name}`;
                player.disconnected = true;
                game.broadcastRoomState(roomCode);
                game.scheduleRoomCleanup(roomCode);
            }
        });
    });
}

module.exports = { registerSocketHandlers };
