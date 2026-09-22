import { state, $, showView, showError, hasOpenGame } from './state.js';
import { stopTimer } from './builder.js';
import { stopNextTimer, stopRestTimer } from './results.js';
import { clearResume } from './identity.js';

// --- CONFIRM DIALOG ---
// Dialogo propio con el estilo del juego (nada de confirm() del navegador).
// Devuelve una promesa: true si el jugador confirma, false si cancela.
export function confirmDialog({ title, message, confirmText = 'Salir', cancelText = 'Cancelar' }) {
    const overlay = $('confirm-overlay');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-accept').textContent = confirmText;
    $('confirm-cancel').textContent = cancelText;

    // Si ya hubiera uno abierto, se resuelve como cancelado
    if (state.closeConfirm) state.closeConfirm(false);

    overlay.hidden = false;
    overlay.classList.remove('hidden');
    // Cancelar tiene el foco: un Enter accidental no saca de la partida
    $('confirm-cancel').focus();

    return new Promise(resolve => {
        state.closeConfirm = (result) => {
            state.closeConfirm = null;
            overlay.hidden = true;
            overlay.classList.add('hidden');
            resolve(result);
        };
    });
}

export function isConfirmOpen() {
    return state.closeConfirm !== null;
}

// --- FICHAS DE INFORMACION ---
// Misma tarjeta que el dialogo de confirmacion, pero sin decision que tomar
const INFO_SHEETS = {
    modes: {
        title: 'Modos de juego',
        body: `
            <p><strong>Normal</strong><br>Cada jugador va a lo suyo: varios podéis encontrar la misma palabra y a todos os puntúa.</p>
            <p><strong>Exclusivo</strong><br>Las palabras se gastan: cada una puntúa solo para quien la envía primero, y al resto se le marca como ya usada.</p>
        `
    },
    rules: {
        title: 'Cómo se juega',
        body: `
            <p>Cada ronda saca un puñado de letras. Forma con ellas todas las palabras que puedas antes de que se acabe el tiempo: puedes repetir una misma letra cuantas veces quieras.</p>
            <p><strong>Puntuación por longitud</strong></p>
            <ul class="info-list">
                <li><span>3 letras</span><span>1 punto</span></li>
                <li><span>4 letras</span><span>2 puntos</span></li>
                <li><span>5 letras</span><span>4 puntos</span></li>
                <li><span>6 letras</span><span>7 puntos</span></li>
                <li><span>7 o más</span><span>10 puntos</span></li>
            </ul>
            <p class="info-note"><strong>PALABREJO</strong><br>La palabra que usa <em>todas</em> las letras del tablero suma <strong>+15 puntos</strong> encima de lo que valga por su longitud. Cuando alguien encuentra uno se avisa a la sala, pero no se dice cuál es.</p>
            <p>Mínimo 3 letras, y tildes y mayúsculas dan igual. No vale repetir una palabra que ya hayas enviado en esa ronda. Al acabar todas las rondas gana quien más puntos lleve.</p>
            <p>Según el modo de la sala, la misma palabra la podéis encontrar varios o se la queda quien la envía primero.</p>
        `
    }
};

export function toggleInfo(open, sheet = 'modes') {
    const overlay = $('info-overlay');
    if (open) {
        $('info-title').textContent = INFO_SHEETS[sheet].title;
        $('info-body').innerHTML = INFO_SHEETS[sheet].body;
    }
    overlay.hidden = !open;
    overlay.classList.toggle('hidden', !open);
    if (open) $('info-close').focus();
}

export function isInfoOpen() {
    return !$('info-overlay').hidden;
}

// Pregunta solo si de verdad hay algo que perder
export async function confirmLeave() {
    if (!hasOpenGame()) return true;
    const playing = state.currentRoom.gameState === 'playing';
    return confirmDialog({
        title: playing ? '¿Salir de la partida?' : '¿Salir de la sala?',
        message: playing
            ? 'La partida sigue en marcha. Si sales ahora pierdes tu puntuación de esta partida y el resto de jugadores continuarán sin ti.'
            : 'Saldrás de la sala y volverás al hall.',
        confirmText: playing ? 'Salir de la partida' : 'Salir de la sala'
    });
}

// Abandona la sala y vuelve al hall. Avisar al servidor es imprescindible:
// si el socket se queda dentro de la sala vieja, la siguiente partida que
// se cree conviviria con ella y las acciones irian a la equivocada.
export function leaveToLobby() {
    stopTimer();
    stopNextTimer();
    stopRestTimer();
    clearResume();
    state.resumeToken = null;
    state.currentRoom = null;
    state.isHost = false;
    state.lastQrUrl = null;
    setPendingRoom(false);
    if (state.socket) state.socket.emit('leaveRoom');
    showView('lobby-view');
}

// Salida forzada al hall (expulsion, sala cerrada por inactividad...): igual
// que leaveToLobby pero avisando del motivo en el mensaje de error del lobby.
export function exitToLobby(msg) {
    leaveToLobby();
    if (msg) showError('lobby-error', msg);
}

// Entrar en una sala es una ida y vuelta con el servidor: hasta que
// confirma no se cambia de vista, para no plantar al jugador en una sala
// en espera vacia si la peticion se rechaza.
export function setPendingRoom(pending) {
    state.pendingRoom = pending;
    $('create-room-btn').disabled = pending;
    $('join-room-btn').disabled = pending;
}

export async function requestLeaveToLobby() {
    if (await confirmLeave()) leaveToLobby();
}
