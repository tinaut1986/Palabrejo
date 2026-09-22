import { state, $ } from './state.js';

// --- QR DE INVITACION (issue #4) ---
// El QR lo genera el propio servidor (GET /api/qr?data=...), que devuelve un
// PNG con el mismo origen: la URL de la sala no sale ya a una API de terceros
// y funciona con la red externa cortada. En fallo se deja el canvas sin
// dibujar (sin fallback de texto: un QR invalido pintado es peor que nada).
export async function generateQRCode(text, canvas) {
    const size = 150;
    let res;
    try {
        res = await fetch(`/api/qr?data=${encodeURIComponent(text)}`, { headers: { Accept: 'image/png' } });
    } catch (e) {
        return;
    }
    if (!res.ok) return;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
        const ctx = canvas.getContext('2d');
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);
        URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
}

// --- WAITING ROOM ---
// Descripciones de los modos, para no repetirlas por la interfaz
const GAME_MODE_LABELS = {
    normal: 'Modo normal: todos podéis enviar la misma palabra.',
    exclusivo: 'Modo exclusivo: cada palabra puntúa solo para quien la envía primero.'
};

// Condiciones con las que se creo la sala: quien entra por un codigo o un
// QR no las ha elegido, asi que las ve aqui antes de empezar.
function renderRoomSummary(state_) {
    const config = state_.config || {};
    const mode = config.gameMode === 'exclusivo' ? 'Exclusivo' : 'Normal';
    const rows = [
        ['Modo', mode],
        ['Rondas', config.totalRounds],
        ['Tiempo por ronda', `${config.roundTime}s`],
        ['Jugadores', `${state_.players.length}/${config.maxPlayers}`],
        ['Sala', config.isPublic ? 'Pública' : 'Privada'],
        ['Bonificaciones', config.bonusesEnabled !== false ? 'Sí' : 'No']
    ];
    $('room-summary').innerHTML = `
        <ul class="summary-list">
            ${rows.map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join('')}
        </ul>
        <p class="summary-note">${GAME_MODE_LABELS[config.gameMode] || GAME_MODE_LABELS.normal}</p>
    `;
}

export function updateWaitingRoom(roomState) {
    $('room-code-display').textContent = roomState.code;
    renderRoomSummary(roomState);

    // Solo play hint
    const soloHint = document.getElementById('solo-hint');
    if (soloHint) soloHint.style.display = roomState.players.length < 2 ? 'block' : 'none';

    // QR: se regenera solo si cambia la sala (evita una peticion externa
    // por cada actualizacion de estado)
    const joinUrl = `${window.location.origin}?join=${roomState.code}`;
    if (state.lastQrUrl !== joinUrl) {
        state.lastQrUrl = joinUrl;
        generateQRCode(joinUrl, $('qr-canvas'));
    }

    // Players. El host ve un boton "Expulsar" junto a cada uno (issue #15):
    // quien se duerme en la sala de espera ocupa plaza hasta el maximo de 12.
    const myId = state.socket?.id;
    const playersHtml = roomState.players.map(p => `
        <div class="player-item">
            <span class="player-name">
                ${p.name}${p.afkWarned ? '<span class="player-afk" title="Sin responder">⚠ sin responder</span>' : ''}
            </span>
            <span class="player-badges">
                ${p.isHost ? '<span class="player-host">HOST</span>' : ''}
                ${state.isHost && !p.isHost && p.id !== myId
                    ? `<button class="btn-secondary btn-sm" data-kick="${p.id}">Expulsar</button>`
                    : ''}
            </span>
        </div>
    `).join('');
    $('waiting-players').innerHTML = playersHtml;

    // Host controls
    if (state.isHost) {
        $('host-controls').classList.remove('hidden');
        $('become-host-controls').classList.add('hidden');
    } else {
        $('host-controls').classList.add('hidden');
        // El anfitrion puede haber dejado la sala abierta o dormirse: quien no
        // lo es tiene la opcion de pedir el rol.
        $('become-host-controls').classList.remove('hidden');
    }
}

export function updateRoomsList(rooms) {
    const list = $('public-rooms-list');
    if (rooms.length === 0) {
        list.innerHTML = '<p class="empty-state">No hay salas públicas disponibles.</p>';
        return;
    }
    list.innerHTML = rooms.map(r => `
        <div class="room-item" data-code="${r.code}">
            <div class="room-info">
                <span class="room-code-label">${r.code}</span>
                <span class="room-players">${r.playerCount}/${r.maxPlayers} jugadores${r.gameMode === 'exclusivo' ? ' · exclusivo' : ''}</span>
            </div>
            <button class="btn-secondary btn-sm" onclick="joinRoom('${r.code}')">Unirse</button>
        </div>
    `).join('');
}

// --- ROOM CONFIG ---
export const configDefaults = { 'max-players': 8, 'total-rounds': 5, 'round-time': 90 };
export const configLimits = {
    'max-players': { min: 2, max: 12, step: 1 },
    'total-rounds': { min: 1, max: 15, step: 1 },
    'round-time': { min: 30, max: 180, step: 15 }
};
