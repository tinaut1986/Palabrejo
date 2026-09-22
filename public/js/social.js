import { state, $, showView, showError } from './state.js';

// --- PROFILE ---
export function openProfile(username, returnView = 'lobby-view') {
    state.profileReturnView = returnView;
    loadProfile(username);
    showView('profile-view');
}

async function loadProfile(username) {
    state.profileUsername = username;
    const isMe = state.currentUser && username === state.currentUser.username;
    $('profile-title').textContent = isMe ? 'Mi perfil' : username;
    $('profile-friend-action').innerHTML = '';
    try {
        const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
        if (!res.ok) throw new Error('No encontrado');
        const data = await res.json();
        if (!isMe) renderProfileFriendAction(username);

        $('profile-body').innerHTML = `
            <h3>${data.username}</h3>
            <p style="color:var(--text-dim);font-size:0.85rem;">Miembro desde ${new Date(data.created_at).toLocaleDateString('es-ES')}</p>
            <div class="stat-grid">
                <div class="stat-card">
                    <div class="stat-value">${data.games_played}</div>
                    <div class="stat-label">Partidas</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${data.games_won}</div>
                    <div class="stat-label">Victorias</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${data.total_words}</div>
                    <div class="stat-label">Palabras</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${data.best_score}</div>
                    <div class="stat-label">Mejor puntuación</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${data.avg_score}</div>
                    <div class="stat-label">Media/partida</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${data.total_score}</div>
                    <div class="stat-label">Puntos totales</div>
                </div>
            </div>
        `;
    } catch (e) {
        $('profile-body').innerHTML = '<p class="empty-state">No se pudo cargar el perfil.</p>';
    }
}

// --- AMIGOS ---
const METRIC_LABELS = {
    total_score: 'puntos',
    games_won: 'victorias',
    best_score: 'mejor partida',
    avg_score: 'media por partida'
};

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.currentUser?.token || ''}`
    };
}

async function fetchFriends() {
    const res = await fetch('/api/friends', { headers: authHeaders() });
    if (!res.ok) throw new Error('No se pudo cargar la lista de amigos.');
    return res.json();
}

// Solo el contador del hall, sin pintar la vista entera
export async function refreshFriendsBadge() {
    if (!state.currentUser) return;
    try {
        state.friendsData = await fetchFriends();
        const badge = $('friends-badge');
        const n = state.friendsData.incoming.length;
        badge.textContent = n;
        badge.classList.toggle('hidden', n === 0);
    } catch (e) { /* sin conexion: el contador puede esperar */ }
}

export async function loadFriends() {
    try {
        state.friendsData = await fetchFriends();
        renderFriends();
        return true;
    } catch (e) {
        showError('friends-error', e.message);
    }
}

export async function friendAction(path, username) {
    try {
        const res = await fetch(`/api/friends/${path}`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ username })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo completar la acción.');
        await loadFriends();
        // El boton de amistad del perfil tambien queda desfasado
        if ($('profile-view').classList.contains('active') && state.profileUsername) {
            renderProfileFriendAction(state.profileUsername);
        }
        return true;
    } catch (e) {
        const target = $('profile-view').classList.contains('active')
            ? 'profile-error' : 'friends-error';
        showError(target, e.message);
        return false;
    }
}

function friendRow(username, actions) {
    return `
        <div class="friend-row">
            <button type="button" class="friend-name" data-user="${username}">${username}</button>
            ${actions}
        </div>
    `;
}

function renderFriends() {
    const { friends, incoming, outgoing } = state.friendsData;

    $('friend-requests').classList.toggle('hidden', incoming.length === 0);
    $('friend-requests-list').innerHTML = incoming.map(u => friendRow(u, `
        <button type="button" class="friend-action accept" data-accept="${u}">Aceptar</button>
        <button type="button" class="friend-action danger" data-remove="${u}">Rechazar</button>
    `)).join('');

    $('friends-pending').classList.toggle('hidden', outgoing.length === 0);
    $('friends-pending-list').innerHTML = outgoing.map(u => friendRow(u, `
        <button type="button" class="friend-action" data-remove="${u}">Cancelar</button>
    `)).join('');

    const badge = $('friends-badge');
    badge.textContent = incoming.length;
    badge.classList.toggle('hidden', incoming.length === 0);

    renderCompare();
}

// Comparativa: yo y mis amigos, ordenados por la metrica elegida
export function renderCompare() {
    const box = $('friends-compare');
    const me = state.friendsData.me;
    if (!me) { box.innerHTML = ''; return; }

    if (state.friendsData.friends.length === 0) {
        box.innerHTML = `<p class="empty-state">Añade amigos para comparar vuestras ${METRIC_LABELS[state.compareMetric]}.</p>`;
        return;
    }

    const rows = [{ ...me, isMe: true }, ...state.friendsData.friends]
        .sort((a, b) => b[state.compareMetric] - a[state.compareMetric]);
    const max = Math.max(...rows.map(r => r[state.compareMetric]), 1);
    const medals = ['🥇', '🥈', '🥉'];

    box.innerHTML = rows.map((r, i) => `
        <div class="compare-row ${r.isMe ? 'is-me' : ''}">
            <span class="compare-rank">${medals[i] || i + 1}</span>
            <span class="compare-name">${r.username}</span>
            <div class="compare-bar-container">
                <div class="compare-bar" style="width:${(r[state.compareMetric] / max) * 100}%"></div>
            </div>
            <span class="compare-value">${r[state.compareMetric]}</span>
        </div>
    `).join('');
}

// Boton de amistad dentro del perfil de otro jugador
function renderProfileFriendAction(username) {
    const box = $('profile-friend-action');
    if (!state.currentUser) { box.innerHTML = ''; return; }

    if (state.friendsData.friends.some(f => f.username === username)) {
        box.innerHTML = `<button type="button" class="friend-action danger" data-remove="${username}">Eliminar de amigos</button>`;
    } else if (state.friendsData.outgoing.includes(username)) {
        box.innerHTML = `<button type="button" class="friend-action" data-remove="${username}">Cancelar solicitud</button>`;
    } else if (state.friendsData.incoming.includes(username)) {
        box.innerHTML = `<button type="button" class="friend-action accept" data-accept="${username}">Aceptar solicitud</button>`;
    } else {
        box.innerHTML = `<button type="button" class="friend-action accept" data-request="${username}">Añadir a amigos</button>`;
    }
}
