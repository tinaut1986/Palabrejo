import { state, $, showView, showError, vibrate, playerDisplayName, hasOpenGame } from './state.js';
import { restoreIdentity, enterLobby, readResume, clearResume, clearIdentity } from './identity.js';
import {
    animateTilePress, shuffleLetters, backspaceBuilt, clearBuilt, submitBuild,
    handleKeyboardKey, addBuiltLetter, stopTimer
} from './builder.js';
import { stopNextTimer, stopRestTimer, updateScores } from './results.js';
import { configLimits } from './lobby.js';
import { openProfile, loadFriends, friendAction, renderCompare } from './social.js';
import {
    toggleInfo, confirmLeave, leaveToLobby, requestLeaveToLobby,
    setPendingRoom, confirmDialog
} from './dialogs.js';

// window.joinRoom lo usan tanto los botones inyectados por innerHTML (lista
// de salas publicas) como el arranque por enlace de invitacion: tiene que
// vivir colgado del global para que el HTML generado dinamicamente lo
// encuentre (issue #7: ya no hay mas asignaciones sueltas a window).
window.joinRoom = function (code) {
    if (!state.socket) return;
    state.socket.emit('joinRoom', {
        roomCode: code,
        playerName: playerDisplayName(),
        sessionToken: state.currentUser?.token
    });
    state.isHost = false;
    setPendingRoom(true);
};

document.addEventListener('DOMContentLoaded', async () => {
    // --- EVENT LISTENERS ---

    $('mode-info-btn').addEventListener('click', () => toggleInfo(true, 'modes'));
    $('how-to-play-btn').addEventListener('click', () => toggleInfo(true, 'rules'));
    $('info-close').addEventListener('click', () => toggleInfo(false));
    $('info-overlay').addEventListener('click', (e) => {
        if (e.target === $('info-overlay')) toggleInfo(false);
    });

    $('confirm-accept').addEventListener('click', () => state.closeConfirm && state.closeConfirm(true));
    $('confirm-cancel').addEventListener('click', () => state.closeConfirm && state.closeConfirm(false));
    // Pulsar fuera de la tarjeta cancela
    $('confirm-overlay').addEventListener('click', (e) => {
        if (e.target === $('confirm-overlay') && state.closeConfirm) state.closeConfirm(false);
    });

    // Recargar (F5, boton de recarga, barra de direcciones) o cerrar la
    // pestana con partida en curso. Es el unico gancho posible para estos
    // casos y el dialogo lo pone el navegador: no se puede maquetar ni
    // cambiarle el texto. Las teclas de recarga no se pueden interceptar,
    // el navegador las atiende antes que la pagina.
    // El valor de returnValue debe ser una cadena NO vacia: asignar '' se
    // interpreta como "no preguntes" y el aviso no aparece.
    window.addEventListener('beforeunload', (e) => {
        if (!hasOpenGame()) return;
        const msg = 'Tienes una partida en curso.';
        e.preventDefault();
        e.returnValue = msg;
        return msg;
    });

    // Setup
    $('show-auth-btn').addEventListener('click', () => {
        $('setup-guest-mode').classList.add('hidden');
        $('setup-auth-mode').classList.remove('hidden');
    });
    $('back-guest-btn').addEventListener('click', () => {
        $('setup-auth-mode').classList.add('hidden');
        $('setup-guest-mode').classList.remove('hidden');
    });

    $('play-guest-btn').addEventListener('click', async () => {
        const name = $('player-name-input').value.trim();
        if (!name || name.length < 2) {
            showError('setup-error', 'El nombre debe tener al menos 2 caracteres.');
            return;
        }
        // Los nombres de cuentas registradas estan reservados: mejor decirlo
        // aqui que dejar que falle al crear la sala
        try {
            const res = await fetch(`/api/name-available/${encodeURIComponent(name)}`);
            const data = await res.json();
            if (data.available === false) {
                showError('setup-error', `"${name}" es una cuenta registrada. Inicia sesión o usa otro nombre.`);
                return;
            }
        } catch (e) { /* si la comprobacion falla, el servidor avisara al crear */ }

        state.currentUser = null;
        state.guestName = name;
        enterLobby();
    });

    $('register-btn').addEventListener('click', async () => {
        const username = $('auth-username').value.trim();
        const password = $('auth-password').value;
        if (!username || !password) {
            showError('setup-error', 'Rellena todos los campos.');
            return;
        }
        try {
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            state.currentUser = { username: data.username, token: data.token };
            state.guestName = '';
            enterLobby();
        } catch (e) {
            showError('setup-error', e.message);
        }
    });

    $('login-btn').addEventListener('click', async () => {
        const username = $('auth-username').value.trim();
        const password = $('auth-password').value;
        if (!username || !password) {
            showError('setup-error', 'Rellena todos los campos.');
            return;
        }
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            state.currentUser = { username: data.username, token: data.token };
            state.guestName = '';
            enterLobby();
        } catch (e) {
            showError('setup-error', e.message);
        }
    });

    // Lobby
    $('create-room-btn').addEventListener('click', () => {
        if (!state.socket) return;
        const isPublic = $('is-public-switch').checked;
        state.socket.emit('createRoom', {
            playerName: playerDisplayName(),
            sessionToken: state.currentUser?.token,
            isPublic,
            maxPlayers: parseInt($('max-players').textContent),
            totalRounds: parseInt($('total-rounds').textContent),
            roundTime: parseInt($('round-time').textContent),
            gameMode: $('game-mode').value,
            bonusesEnabled: $('bonuses-enabled').value === '1'
        });
        state.isHost = true;
        setPendingRoom(true);
    });

    $('join-room-btn').addEventListener('click', () => {
        const code = $('room-code-input').value.trim().toUpperCase();
        if (code.length !== 4) {
            showError('lobby-error', 'El código debe tener 4 letras.');
            return;
        }
        window.joinRoom(code);
    });

    $('browse-rooms-btn').addEventListener('click', () => {
        state.socket.emit('getPublicRooms');
        showView('room-browser-view');
    });

    $('back-to-lobby-btn').addEventListener('click', () => showView('lobby-view'));

    // Room config steppers
    document.querySelectorAll('.stepper-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            const dir = parseInt(btn.dataset.dir);
            const limits = configLimits[target];
            const el = $(target);
            let val = parseInt(el.textContent) + dir * limits.step;
            val = Math.max(limits.min, Math.min(limits.max, val));
            el.textContent = val;
        });
    });

    // Waiting room
    $('start-game-btn').addEventListener('click', () => {
        state.socket.emit('startGame');
    });

    // Pedir el rol de anfitrion: el servidor se lo pregunta al host actual.
    $('become-host-btn').addEventListener('click', async () => {
        if (!(await confirmDialog({
            title: '¿Pasar a ser anfitrión?',
            message: 'Se lo preguntaremos al anfitrión actual. Si acepta, tú tomarás el control de la sala.',
            confirmText: 'Pedir',
            cancelText: 'Cancelar'
        }))) return;
        state.socket.emit('becomeHost');
    });

    $('leave-room-btn').addEventListener('click', requestLeaveToLobby);

    // Game
    // Rack letters are clickable (delegated, survives innerHTML swaps)
    $('letters-display').addEventListener('click', (e) => {
        const tile = e.target.closest('.letter-tile');
        if (!tile || !$('game-view').classList.contains('active')) return;
        addBuiltLetter(tile.dataset.letter);
        animateTilePress(tile);
        vibrate(8);
    });
    $('game-exit-btn').addEventListener('click', requestLeaveToLobby);
    $('results-exit-btn').addEventListener('click', requestLeaveToLobby);
    $('shuffle-btn').addEventListener('click', shuffleLetters);
    $('backspace-btn').addEventListener('click', backspaceBuilt);
    $('clear-btn').addEventListener('click', clearBuilt);
    $('submit-built-btn').addEventListener('click', submitBuild);
    // Keyboard: forming words typing on a PC
    document.addEventListener('keydown', handleKeyboardKey);

    // Game over
    $('back-to-lobby-final').addEventListener('click', leaveToLobby);

    // Profile
    // El nombre del hall es el acceso al perfil
    $('user-badge').addEventListener('click', () => {
        if (state.currentUser) openProfile(state.currentUser.username, 'lobby-view');
    });
    $('back-from-profile-btn').addEventListener('click', () => showView(state.profileReturnView));

    // Amigos
    $('view-friends-btn').addEventListener('click', () => {
        if (!state.currentUser) return;
        showView('friends-view');
        loadFriends();
    });
    $('back-from-friends-btn').addEventListener('click', () => showView('lobby-view'));

    $('add-friend-btn').addEventListener('click', async () => {
        const name = $('add-friend-input').value.trim();
        if (!name) return showError('friends-error', 'Escribe un nombre de jugador.');
        if (await friendAction('request', name)) $('add-friend-input').value = '';
    });
    $('add-friend-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('add-friend-btn').click();
    });

    // Delegado: las listas se repintan enteras al cambiar algo
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-accept], [data-remove], [data-request], .friend-name');
        if (!btn) return;
        if (btn.dataset.accept) return void friendAction('accept', btn.dataset.accept);
        if (btn.dataset.request) return void friendAction('request', btn.dataset.request);
        if (btn.dataset.remove) return void friendAction('remove', btn.dataset.remove);
        if (btn.classList.contains('friend-name')) {
            openProfile(btn.dataset.user, 'friends-view');
        }
    });

    // Expulsar a un jugador de la sala de espera (issue #15): solo se embuja
    // el boton al host, pero el click llega delegado porque la lista se
    // repinta entera al cambiar el estado.
    document.addEventListener('click', (e) => {
        const kick = e.target.closest('[data-kick]');
        if (!kick) return;
        e.preventDefault();
        const target = state.currentRoom?.players.find(p => p.id === kick.dataset.kick);
        confirmDialog({
            title: '¿Expulsar a este jugador?',
            message: `Expulsarás a ${target?.name ?? 'ese jugador'} de la sala de espera.`,
            confirmText: 'Expulsar',
            cancelText: 'Cancelar'
        }).then(ok => {
            if (ok) state.socket.emit('kickPlayer', { targetId: kick.dataset.kick });
        });
    });

    $('metric-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.metric-tab');
        if (!tab) return;
        document.querySelectorAll('.metric-tab').forEach(t => t.classList.toggle('active', t === tab));
        state.compareMetric = tab.dataset.metric;
        renderCompare();
    });

    // Logout
    $('logout-btn').addEventListener('click', async () => {
        if (!(await confirmLeave())) return;
        clearIdentity();
        state.currentUser = null;
        state.guestName = '';
        stopTimer();
        stopNextTimer();
        stopRestTimer();
        clearResume();
        state.resumeToken = null;
        state.currentRoom = null;
        state.isHost = false;
        state.lastQrUrl = null;
        if (state.socket) {
            state.socket.emit('leaveRoom');
            state.socket.disconnect();
        }
        state.socket = null;
        showView('setup-view');
    });

    // Periodic scores update
    setInterval(updateScores, 500);

    // --- ARRANQUE ---
    // Codigo de sala en la URL (enlace o QR compartido)
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode) {
        $('room-code-input').value = joinCode.toUpperCase();
    }

    // Si ya sabemos quien juega, al hall directamente; si no, a presentarse.
    // Conectar aqui es lo que permite, ademas, que un F5 en plena partida
    // reanude solo, sin volver a escribir el nombre.
    if (!(await restoreIdentity())) {
        showView('setup-view');
    } else if (joinCode && !readResume()) {
        // Venimos de un enlace de invitacion y no hay partida que reanudar:
        // entrar en la sala sin mas pasos
        window.joinRoom(joinCode.toUpperCase());
    }
});
