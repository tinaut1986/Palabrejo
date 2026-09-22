import { state, $, showView, showError, showFeedback, flashElement, shakeElement, vibrate, canonicalLetter, playerDisplayName } from './state.js';
import { saveResume, readResume, clearResume, clearIdentity } from './identity.js';
import { startTimer, stopTimer, addWordChip, clearBuilt, markLatest, clearActiveBonus, showLetterBonus, renderMyWords, renderBuiltWord } from './builder.js';
import { stopNextTimer, stopRestTimer, startRestCountdown, showRoundResults, showGameOver, updateScores, updateScorePills } from './results.js';
import { updateWaitingRoom, updateRoomsList } from './lobby.js';
import { setPendingRoom, exitToLobby, confirmDialog } from './dialogs.js';

// --- NOTICIAS DE SALA (issue #15) ---
// Avisos cortos y efimeros (traspasos de host, expulsiones, avisos AFK). Se
// muestran en la sala de espera; si estamos en plena partida, sobre la zona
// de feedback para que no se pierdan.
function showRoomNotice(text) {
    const notice = $('room-notice');
    if (notice) {
        notice.textContent = text;
        clearTimeout(notice._timer);
        notice._timer = setTimeout(() => { if (notice) notice.textContent = ''; }, 8000);
    }
    if ($('game-view').classList.contains('active')) showFeedback(text, 'valid');
}

// --- SOCKET CONNECTION ---
export function connectSocket() {
    state.socket = io();

    state.socket.on('connect', () => {
        console.log('Connected to server');
        const stored = readResume();
        if (state.resumeToken && state.currentRoom) {
            // Live reconnection after a drop: get back into the game
            state.socket.emit('rejoinGame', { roomCode: state.currentRoom.code, token: state.resumeToken });
        } else if (stored && !state.currentRoom) {
            // Reload mid-game
            state.socket.emit('rejoinGame', { roomCode: stored.code, token: stored.token });
        }
    });

    state.socket.on('disconnect', () => {
        if (state.resumeToken) showFeedback('Reconectando…', 'invalid');
    });

    state.socket.on('playerToken', ({ roomCode, token }) => {
        state.resumeToken = token;
        saveResume(roomCode, token);
    });

    state.socket.on('error', (msg) => {
        showError('lobby-error', msg);
        showError('setup-error', msg);
        // Cualquier error de sala deja el contexto de partida inservible.
        // Se limpia siempre, tambien cuando el estado local ya esta vacio:
        // justo tras recargar quedaba un token de reanudacion caducado.
        clearResume();
        state.resumeToken = null;
        // Si esperabamos entrar en una sala, la entrada se ha ido al garete
        if (state.pendingRoom || state.currentRoom) {
            setPendingRoom(false);
            state.currentRoom = null;
            stopTimer();
            stopNextTimer();
            showView('lobby-view');
        }
    });

    // La sesion guardada ya no vale: olvidarla y volver a la pantalla de acceso
    state.socket.on('sessionExpired', (msg) => {
        clearIdentity();
        state.currentUser = null;
        state.guestName = '';
        state.currentRoom = null;
        state.resumeToken = null;
        clearResume();
        stopTimer();
        stopNextTimer();
        showView('setup-view');
        showError('setup-error', msg);
    });

    state.socket.on('roomStateUpdate', (roomState) => {
        const isRejoin = !state.currentRoom;
        const wasPending = state.pendingRoom;
        setPendingRoom(false);
        state.currentRoom = roomState;
        state.isHost = roomState.players.find(p => p.id === state.socket.id)?.isHost;
        // Solo refrescamos la sala de espera si es donde estamos: en juego
        // este evento llega con cada palabra acertada y regenerar el QR
        // dispararia una peticion externa por palabra.
        if (roomState.gameState === 'waiting') {
            updateWaitingRoom(roomState);
            // La sala solo se muestra con datos ya en mano: al confirmarse
            // la entrada, o al volver a ella tras un F5
            if (wasPending || isRejoin) showView('waiting-room-view');
        }
        updateScores();
    });

    state.socket.on('roundStart', (data) => {
        stopNextTimer();
        stopRestTimer();
        showView('game-view');
        // El total de rondas viene en el evento: al reanudar tras un F5
        // puede que aún no tengamos el estado de la sala.
        const totalRounds = data.totalRounds || state.currentRoom?.totalRounds || '?';
        $('round-display').textContent = `Ronda ${data.round}/${totalRounds}`;

        state.rackLetters = data.letters.map(l => canonicalLetter(l));
        state.displayLetters = [...data.letters];
        state.builtWord = [];
        clearActiveBonus();
        renderBuiltWord();

        // Al reanudar, el servidor devuelve las palabras ya acertadas
        state.myWords = (data.words || []).map(w => ({
            key: canonicalLetter(w.word),
            word: w.word,
            type: 'valid',
            points: w.points,
            palabrejo: w.palabrejo
        }));
        state.latestWordKey = null;
        renderMyWords();
        state.roundScore = state.myWords.reduce((sum, w) => sum + (w.points || 0), 0);
        updateScorePills();

        state.timeLeft = data.time;
        startTimer();
    });

    // Bonus/castigo que aparece sobre una letra del tablero
    state.socket.on('letterBonus', (data) => {
        showLetterBonus(data);
    });
    state.socket.on('letterBonusExpired', (data) => {
        if (state.activeLetterBonus && canonicalLetter(state.activeLetterBonus.letter) === canonicalLetter(data.letter)) {
            clearActiveBonus();
        }
        if (data.reason === 'used' && data.playerName !== playerDisplayName()) {
            showFeedback(`${data.playerName} ha usado el bonus de la '${data.letter.toUpperCase()}' (${data.label})`, data.kind === 'steal' ? 'palabrejo' : 'valid');
        }
    });
    state.socket.on('bonusStolen', (data) => {
        if (data.from === playerDisplayName()) {
            showFeedback(`${data.to} te ha robado ${data.amount} puntos`, 'invalid');
            vibrate([15, 40, 15]);
        }
    });

    state.socket.on('wordResult', (data) => {
        if (data.valid) {
            addWordChip(data.word, 'valid', data.points, data.palabrejo, data.basePoints, data.bonusApplied);
            const bonusNote = data.bonusApplied ? ` (bonus ${data.bonusApplied.label})` : '';
            showFeedback(
                data.palabrejo
                    ? `¡PALABREJO! ${data.word.toUpperCase()} +${data.points}`
                    : `${data.word.toUpperCase()} +${data.points}${bonusNote}`,
                data.palabrejo ? 'palabrejo' : 'valid'
            );
            state.roundScore += data.points;
            updateScorePills();
            flashElement($('built-word'), 'flash-ok');
            vibrate(data.palabrejo ? 60 : 15);
        } else {
            // Una palabra repetida ya esta acertada en la lista: se queda
            // como esta (con sus puntos) y solo se marca como ultima
            // jugada. El resto de fallos si entran como ficha roja.
            if (data.reason === 'duplicate') {
                markLatest(canonicalLetter(data.word));
            } else {
                addWordChip(data.word, 'invalid');
            }
            const msgs = {
                duplicate: 'Ya usaste esa palabra',
                used_by_other: 'Otro jugador ya la usó',
                invalid: 'Palabra no válida',
                throttled: 'Vas muy rápido, espera un momento'
            };
            showFeedback(msgs[data.reason] || 'No válida', 'invalid');
            shakeElement($('built-word'));
            vibrate([15, 40, 15]);
        }
        // After trying a word the builder clears for the next one
        clearBuilt();
    });

    // Alguien ha encontrado un PALABREJO: se avisa a la sala de que el
    // tablero lo tiene, pero no de cual es. A buscarlo.
    state.socket.on('palabrejo', (data) => {
        // A quien lo ha encontrado ya se lo dice wordResult
        if (data.playerName === playerDisplayName()) return;
        showFeedback(`${data.playerName} ha encontrado un PALABREJO (+${data.bonus})`, 'palabrejo');
    });

    state.socket.on('roundEnd', (data) => {
        stopTimer();
        clearActiveBonus();
        showRoundResults(data);
    });

    // Llega justo despues de roundEnd, personalizado: solo mis palabras
    // que se me escaparon, no las de los demas
    state.socket.on('roundMissedWords', (data) => {
        const el = $('round-missed-words');
        if (!el) return;
        if (!data.words.length) {
            el.innerHTML = '<h3 class="results-subtitle">¡No se te escapó ninguna! 🎉</h3>';
            return;
        }
        el.innerHTML = `
            <h3 class="results-subtitle">Se te escaparon estas</h3>
            <div class="result-words">
                ${data.words.map(w => `<span class="word-chip invalid" style="display:inline-block;margin:2px;font-size:0.8rem;">${w}</span>`).join('')}
            </div>
        `;
    });

    state.socket.on('gameOver', (data) => {
        stopTimer();
        stopNextTimer();
        // La partida ha terminado: salir ya no pide confirmacion
        if (state.currentRoom) state.currentRoom.gameState = 'rest';
        showGameOver(data);
    });

    // Tras el fin de la partida hay un descanso y arranca otra nueva con
    // los mismos jugadores. El servidor lo confirma con esta cuenta atras.
    state.socket.on('restStart', (data) => {
        stopNextTimer();
        showView('game-over-view');
        startRestCountdown(data.delay);
    });

    // --- SALUD DE SALAS (issue #15) ---
    state.socket.on('roomNotice', (data) => {
        showRoomNotice(data?.text);
    });

    // El host rechaza/aprueba, te avisan, un jugador dormido... Aviso AFK al
    // propio durmiente: lleva un rato sin responder.
    state.socket.on('afkWarning', () => {
        const notice = $('room-notice');
        if (notice) {
            notice.textContent = 'Llevas un rato sin responder. ¡Sigue conectado o el anfitrión puede expulsarte!';
            clearTimeout(notice._timer);
            notice._timer = setTimeout(() => { if (notice) notice.textContent = ''; }, 8000);
        }
        vibrate([15, 40, 15]);
    });

    // El host esta en la sala (waiting) y alguien pide su rol: confirmar.
    state.socket.on('becomeHostRequest', async (data) => {
        const ok = await confirmDialog({
            title: '¿Ceder el mando?',
            message: `${data.requesterName} quiere convertirse en anfitrión de la sala. ¿Le pasas el rol?`,
            confirmText: 'Ceder',
            cancelText: 'Mantener'
        });
        state.socket.emit('respondHostRequest', { requestId: data.requestId, approve: ok });
    });

    // El host te ha expulsado de la sala de espera: fuera, con el motivo.
    state.socket.on('kicked', (msg) => {
        exitToLobby(msg || 'El anfitrión te ha expulsado de la sala.');
    });

    // El sweep cerro la sala waiting por inactividad del anfitrion.
    state.socket.on('roomClosed', (msg) => {
        exitToLobby(msg || 'La sala de espera se ha cerrado por inactividad.');
    });

    state.socket.on('publicRoomsList', (rooms) => {
        updateRoomsList(rooms);
    });
}
