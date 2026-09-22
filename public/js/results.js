import { state, $, showView, setPill } from './state.js';

// --- CUENTA ATRAS ENTRE RONDA Y RONDA / DESCANSO ---
export function startNextCountdown() {
    stopNextTimer();
    let s = 5;
    const el = $('round-results-next');
    if (el) el.textContent = `Siguiente ronda en ${s} s...`;
    state.nextTimer = setInterval(() => {
        s--;
        if (s <= 0) {
            stopNextTimer();
            if (el) el.textContent = 'Esperando a los demás...';
        } else {
            if (el) el.textContent = `Siguiente ronda en ${s} s...`;
        }
    }, 1000);
}

export function stopNextTimer() {
    if (state.nextTimer) {
        clearInterval(state.nextTimer);
        state.nextTimer = null;
    }
}

// Cuenta atras del descanso entre partidas: muestra en la pantalla de fin
// el tiempo que falta para que arranque la siguiente partida.
export function startRestCountdown(delayMs) {
    stopRestTimer();
    const el = $('game-over-next');
    if (!el) return;
    let s = Math.max(1, Math.ceil(delayMs / 1000));
    el.innerHTML = `Nueva partida en <span class="rest-countdown-num">${s}s</span>`;
    state.restTimer = setInterval(() => {
        s--;
        if (s <= 0) {
            stopRestTimer();
            el.innerHTML = `Nueva partida en <span class="rest-countdown-num">0s</span>`;
        } else {
            el.innerHTML = `Nueva partida en <span class="rest-countdown-num">${s}s</span>`;
        }
    }, 1000);
}

export function stopRestTimer() {
    if (state.restTimer) {
        clearInterval(state.restTimer);
        state.restTimer = null;
    }
}

// --- ROUND RESULTS ---
// Por jugador solo se ven unas pocas (las mas largas primero); el resto
// se resume en un "+N más" para no saturar la pantalla.
const ROUND_WORDS_SHOWN = 6;

export function showRoundResults(data) {
    showView('round-results-view');
    $('round-results-title').textContent = `Resultados - Ronda ${data.round}`;

    const sorted = [...data.results].sort((a, b) => b.totalScore - a.totalScore);
    $('round-results-body').innerHTML = sorted.map((p, i) => {
        const isMe = p.id === state.socket.id;
        const words = [...p.wordsThisRound].sort((a, b) => b.length - a.length || a.localeCompare(b));
        const shown = words.slice(0, ROUND_WORDS_SHOWN);
        const extra = words.length - shown.length;
        return `
            <div class="result-player">
                <span class="result-name ${isMe ? 'score-you' : ''}">
                    ${i === 0 ? '👑 ' : ''}${p.name}
                </span>
                <span class="result-score">${p.totalScore} pts <small class="result-round">(+${p.scoreThisRound || 0} esta ronda)</small></span>
                <div class="result-words">
                    ${shown.length > 0
                        ? shown.map(w => `<span class="word-chip valid" style="display:inline-block;margin:2px;font-size:0.75rem;">${w}</span>`).join('')
                        : '<em>No formó palabras</em>'}
                    ${extra > 0 ? `<span class="word-chip-more">+${extra} más</span>` : ''}
                </div>
            </div>
        `;
    }).join('');

    renderTopWords(data.topWords || []);
    $('round-missed-words').innerHTML = '';

    startNextCountdown();
}

// Las palabras mas largas de la ronda, con quien las encontro
function renderTopWords(topWords) {
    const el = $('round-top-words');
    if (!el) return;
    if (!topWords.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
        <h3 class="results-subtitle">Las más largas de la ronda</h3>
        <div class="result-words">
            ${topWords.map(t => `<span class="word-chip valid" style="display:inline-block;margin:2px;font-size:0.8rem;">${t.word} <small>(${[...new Set(t.players)].join(', ')})</small></span>`).join('')}
        </div>
    `;
}

// --- GAME OVER ---
export function showGameOver(data) {
    showView('game-over-view');
    $('game-over-title').textContent = `🏆 ${data.winner.name} gana!`;

    $('game-over-body').innerHTML = data.players.map((p, i) => {
        const words = [...p.wordsFound].sort((a, b) => b.length - a.length || a.localeCompare(b));
        const shown = words.slice(0, ROUND_WORDS_SHOWN);
        const extra = words.length - shown.length;
        return `
        <div class="result-player">
            <span class="result-name">
                ${i === 0 ? '👑 ' : ''}${p.name}
                ${i === 0 ? '<span class="winner-badge">CAMPEÓN</span>' : ''}
            </span>
            <span class="result-score">${p.score} pts</span>
            <div class="result-words">
                ${shown.map(w => `<span class="word-chip valid" style="display:inline-block;margin:2px;font-size:0.75rem;">${w}</span>`).join('')}
                ${extra > 0 ? `<span class="word-chip-more">+${extra} más</span>` : ''}
            </div>
        </div>
    `;
    }).join('');

    // Tus palabras más largas de toda la partida, para ti solo
    const me = data.players.find(p => p.id === state.socket.id);
    const myBestEl = $('game-over-my-best');
    if (myBestEl) {
        if (me && me.wordsFound.length) {
            const myTop = [...me.wordsFound].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 5);
            myBestEl.innerHTML = `
                <h3 class="results-subtitle">Tus palabras más largas</h3>
                <div class="result-words">
                    ${myTop.map(w => `<span class="word-chip valid" style="display:inline-block;margin:2px;font-size:0.8rem;">${w}</span>`).join('')}
                </div>
            `;
        } else {
            myBestEl.innerHTML = '';
        }
    }

    renderGameOverList('game-over-most-found', 'Las más repetidas', data.mostFound, t => `${t.word} <small>(${t.count}×)</small>`);
    renderGameOverList('game-over-longest', 'Las más largas de la partida', data.longestWords, t => `${t.word} <small>(${[...new Set(t.players)].join(', ')})</small>`);
}

function renderGameOverList(elId, title, items, formatItem) {
    const el = $(elId);
    if (!el) return;
    if (!items || !items.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
        <h3 class="results-subtitle">${title}</h3>
        <div class="result-words">
            ${items.map(t => `<span class="word-chip valid" style="display:inline-block;margin:2px;font-size:0.8rem;">${formatItem(t)}</span>`).join('')}
        </div>
    `;
}

// --- SCORES UPDATE ---
// Pinta el marcador (total + puntos de la ronda en curso) y las píldoras
// de cabecera con mi ronda, mi total y mi puesto.
export function updateScores() {
    if (!state.currentRoom) return;
    const players = [...state.currentRoom.players].sort((a, b) => b.score - a.score);
    const maxScore = Math.max(...players.map(p => p.score), 1);

    $('scores-list').innerHTML = players.map(p => {
        const isMe = p.id === state.socket.id;
        const pct = (p.score / maxScore) * 100;
        const leading = p.score === maxScore && maxScore > 0;
        const rs = p.roundScore || 0;
        return `
            <div class="score-row">
                <span class="score-name ${isMe ? 'score-you' : ''}">${p.name}</span>
                <div class="score-bar-container">
                    <div class="score-bar ${leading ? 'leading' : ''}" style="width: ${pct}%"></div>
                </div>
                <span class="score-round ${rs ? '' : 'zero'}">+${rs}</span>
                <span class="score-value">${p.score}</span>
            </div>
        `;
    }).join('');

    const me = players.find(p => p.id === state.socket.id);
    if (me) {
        state.roundScore = me.roundScore || 0;
        state.myTotalScore = me.score || 0;
        state.myRank = `${players.indexOf(me) + 1}/${players.length}`;
    }
    updateScorePills();
}

export function updateScorePills() {
    setPill('round-score', state.roundScore);
    setPill('total-score', state.myTotalScore);
    const rank = $('rank-display');
    if (rank) rank.textContent = state.myRank;
}
