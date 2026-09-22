import { state, $ } from './state.js';

// --- QR CODE GENERATOR (minimal) ---
export function generateQR(text, canvas, size = 150) {
    const ctx = canvas.getContext('2d');
    canvas.width = size;
    canvas.height = size;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';

    // Simple QR-like visual placeholder (real QR would need a library)
    // We'll encode the URL as a visual pattern
    const url = text;
    const moduleCount = 21;
    const cellSize = size / moduleCount;

    // Use a deterministic pattern based on the URL
    const data = [];
    for (let i = 0; i < moduleCount * moduleCount; i++) {
        const charCode = url.charCodeAt(i % url.length) || 0;
        data.push((charCode + i * 7) % 3 === 0);
    }

    // Finder patterns
    const drawFinder = (x, y) => {
        for (let dy = 0; dy < 7; dy++) {
            for (let dx = 0; dx < 7; dx++) {
                const isEdge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
                const isInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
                if (isEdge || isInner) {
                    ctx.fillRect((x + dx) * cellSize, (y + dy) * cellSize, cellSize, cellSize);
                }
            }
        }
    };

    drawFinder(0, 0);
    drawFinder(moduleCount - 7, 0);
    drawFinder(0, moduleCount - 7);

    // Fill data area
    for (let y = 0; y < moduleCount; y++) {
        for (let x = 0; x < moduleCount; x++) {
            const inFinder = (x < 8 && y < 8) || (x >= moduleCount - 8 && y < 8) || (x < 8 && y >= moduleCount - 8);
            if (!inFinder && data[y * moduleCount + x]) {
                ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
            }
        }
    }
}

// For a proper QR code, let's use a simple API fallback
export function generateQRCode(text, canvas) {
    const size = 150;
    const ctx = canvas.getContext('2d');
    canvas.width = size;
    canvas.height = size;

    // Use a QR code API for proper rendering
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        ctx.drawImage(img, 0, 0, size, size);
    };
    img.onerror = () => {
        // Fallback: just show the text
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000000';
        ctx.font = '12px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(text, size / 2, size / 2);
    };
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
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

    // Players
    const playersHtml = roomState.players.map(p => `
        <div class="player-item">
            <span class="player-name">${p.name}</span>
            ${p.isHost ? '<span class="player-host">HOST</span>' : ''}
        </div>
    `).join('');
    $('waiting-players').innerHTML = playersHtml;

    // Host controls
    if (state.isHost) {
        $('host-controls').classList.remove('hidden');
    } else {
        $('host-controls').classList.add('hidden');
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
