import { state, $, showView, showError } from './state.js';
import { connectSocket } from './network.js';
import { refreshFriendsBadge } from './social.js';

// --- RESUME STORAGE ---
// Survives a page reload so a player can get back into an in-progress game.
export function saveResume(roomCode, token) {
    try { sessionStorage.setItem('palabrejoResume', JSON.stringify({ code: roomCode, token })); } catch (e) {}
}
export function readResume() {
    try { return JSON.parse(sessionStorage.getItem('palabrejoResume') || 'null'); } catch (e) { return null; }
}
export function clearResume() {
    try { sessionStorage.removeItem('palabrejoResume'); } catch (e) {}
}

// --- IDENTIDAD PERSISTENTE ---
// Recuerda con quien se jugo la ultima vez (registrado o invitado) para no
// tener que volver a presentarse. En localStorage, asi que sobrevive a
// cerrar el navegador, al contrario que el token de reanudacion de partida.
const IDENTITY_KEY = 'palabrejoIdentity';

export function saveIdentity() {
    try {
        const identity = state.currentUser
            ? { type: 'user', username: state.currentUser.username, token: state.currentUser.token }
            : { type: 'guest', name: state.guestName };
        localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    } catch (e) {}
}

export function readIdentity() {
    try {
        const raw = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
        if (!raw) return null;
        if (raw.type === 'user' && raw.username && raw.token) return raw;
        if (raw.type === 'guest' && raw.name) return raw;
        return null;
    } catch (e) { return null; }
}

export function clearIdentity() {
    try { localStorage.removeItem(IDENTITY_KEY); } catch (e) {}
}

export function updateUserBadge() {
    const badge = $('user-badge');
    badge.textContent = state.currentUser
        ? `🎮 ${state.currentUser.username}`
        : `👤 ${state.guestName} (invitado)`;
    // Un invitado no tiene perfil ni amigos: el badge no es pulsable
    badge.classList.toggle('plain', !state.currentUser);
    badge.title = state.currentUser ? 'Ver mi perfil' : '';
    $('view-friends-btn').classList.toggle('hidden', !state.currentUser);
    if (state.currentUser) refreshFriendsBadge();
}

// Entra al hall con la identidad ya fijada
export function enterLobby() {
    saveIdentity();
    updateUserBadge();
    if (!state.socket) connectSocket();
    showView('lobby-view');
}

// Al arrancar: si ya sabemos quien juega, directo al hall. La sesion de un
// usuario registrado se revalida contra el servidor, que es quien dice si
// el token sigue siendo bueno.
export async function restoreIdentity() {
    const identity = readIdentity();
    if (!identity) return false;

    if (identity.type === 'guest') {
        // El nombre pudo registrarse como cuenta despues de guardarse aqui
        try {
            const res = await fetch(`/api/name-available/${encodeURIComponent(identity.name)}`);
            if ((await res.json()).available === false) {
                clearIdentity();
                $('player-name-input').value = identity.name;
                showError('setup-error', `"${identity.name}" ya es una cuenta registrada. Inicia sesión o usa otro nombre.`);
                return false;
            }
        } catch (e) { /* sin red, se deja pasar: el servidor avisara */ }

        state.currentUser = null;
        state.guestName = identity.name;
        $('player-name-input').value = identity.name;
        enterLobby();
        return true;
    }

    try {
        const res = await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: identity.token })
        });
        if (!res.ok) throw new Error('Sesión caducada');
        const data = await res.json();
        state.currentUser = { username: data.username, token: identity.token };
        state.guestName = '';
        enterLobby();
        return true;
    } catch (e) {
        // Token caducado o revocado: a presentarse de nuevo
        clearIdentity();
        return false;
    }
}
