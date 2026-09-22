import { state, $, canonicalLetter, showFeedback, vibrate } from './state.js';
import { isInfoOpen, toggleInfo, isConfirmOpen } from './dialogs.js';

// --- TIMER (cuenta atras de la ronda en juego) ---
export function startTimer() {
    stopTimer();
    updateTimerDisplay();
    state.roundTimer = setInterval(() => {
        state.timeLeft--;
        updateTimerDisplay();
        if (state.timeLeft <= 0) {
            stopTimer();
            // Ask the server to wrap up the round (safe: it only honours
            // this in the final seconds, and ignores it if already ended).
            if (state.socket) state.socket.emit('roundTimeout');
        }
    }, 1000);
}

export function stopTimer() {
    if (state.roundTimer) {
        clearInterval(state.roundTimer);
        state.roundTimer = null;
    }
}

function updateTimerDisplay() {
    const el = $('timer-display');
    el.textContent = `${state.timeLeft}s`;
    el.className = 'timer';
    if (state.timeLeft <= 10) el.classList.add('danger');
    else if (state.timeLeft <= 30) el.classList.add('warning');
}

// --- WORD INPUT ---
// Las palabras se guardan en una lista y se pintan siempre en orden
// alfabético (por su forma canónica, así "á" ordena junto a "a").
// Reintentar una palabra actualiza su entrada en lugar de duplicarla.

export function markLatest(key) {
    state.latestWordKey = key;
    renderMyWords();
}

export function addWordChip(word, type, points = 0, palabrejo = false, basePoints = null, bonusApplied = null) {
    const key = canonicalLetter(word);
    const existing = state.myWords.find(w => w.key === key);
    if (existing) {
        existing.word = word;
        existing.type = type;
        existing.points = points;
        existing.palabrejo = palabrejo;
        existing.basePoints = basePoints;
        existing.bonusApplied = bonusApplied;
    } else {
        state.myWords.push({ key, word, type, points, palabrejo, basePoints, bonusApplied });
    }
    markLatest(key);
}

// "+15 (11+4)": el total y, entre parentesis, base y modificador aplicado
const BONUS_OP = { multiply: 'x', add: '+', divide: '÷', subtract: '-', steal: '+' };
function pointsLabel(w) {
    if (!w.bonusApplied || w.basePoints == null) return `<small>+${w.points}</small>`;
    const op = BONUS_OP[w.bonusApplied.kind] || '+';
    return `<small>+${w.points} (${w.basePoints}${op}${w.bonusApplied.value})</small>`;
}

export function renderMyWords() {
    const sorted = [...state.myWords].sort((a, b) => a.key.localeCompare(b.key, 'es'));
    $('my-words-list').innerHTML = sorted.map(w => `
        <span class="word-chip ${w.type}${w.palabrejo ? ' palabrejo' : ''}${w.key === state.latestWordKey ? ' latest' : ''}" data-key="${w.key}">${w.word}${w.type === 'valid' && w.points ? pointsLabel(w) : ''}</span>
    `).join('');
    const validCount = state.myWords.filter(w => w.type === 'valid').length;
    const countEl = $('my-words-count');
    if (countEl) countEl.textContent = validCount;
}

// --- WORD BUILDER ---

// En móvil no hay teclado físico: el texto de ayuda se adapta
const BUILDER_HINT = window.matchMedia('(hover: hover) and (pointer: fine)').matches
    ? 'Pulsa las letras o escribe con el teclado'
    : 'Pulsa las letras para formar tu palabra';

// Feedback de pulsación: hunde la tecla y lanza una letra "fantasma"
// desde ella hasta la palabra en construcción.
export function animateTilePress(tile) {
    if (!tile) return;
    tile.classList.remove('pressed');
    void tile.offsetWidth;
    tile.classList.add('pressed');
    setTimeout(() => tile.classList.remove('pressed'), 300);
    flyLetterToWord(tile);
}

function flyLetterToWord(tile) {
    const target = $('built-word');
    if (!target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = tile.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'letter-ghost';
    ghost.textContent = tile.dataset.letter || tile.textContent;
    ghost.style.left = `${from.left}px`;
    ghost.style.top = `${from.top}px`;
    ghost.style.width = `${from.width}px`;
    ghost.style.height = `${from.height}px`;
    document.body.appendChild(ghost);
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    ghost.animate([
        { transform: 'translate(0,0) scale(1)', opacity: 0.95 },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) scale(0.8)`, opacity: 0.7 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 }
    ], { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)' }).onfinish = () => ghost.remove();
}

// Localiza la tecla del rack correspondiente a una letra escrita a teclado
export function findTile(letter) {
    const cl = canonicalLetter(letter);
    return [...document.querySelectorAll('#letters-display .letter-tile')]
        .find(t => canonicalLetter(t.dataset.letter) === cl);
}

// Las letras del tablero en el orden en que se pintan. Barajarlas no
// cambia nada del juego: ayuda a ver combinaciones nuevas.
export function renderLetters() {
    $('letters-display').innerHTML = state.displayLetters
        .map(l => `<button type="button" class="letter-tile" data-letter="${l}">${l}${bonusBadgeHtml(l)}</button>`)
        .join('');
}

// Marquita circular con la cuenta atras (en segundos) sobre la letra que
// tiene un bonus/castigo activo, con su etiqueta (x2, +5, ÷2, -5, robo).
function bonusBadgeHtml(letter) {
    const bonus = state.activeLetterBonus;
    if (!bonus || canonicalLetter(letter) !== canonicalLetter(bonus.letter)) return '';
    const secs = Math.max(0, Math.ceil((bonus.expiresAt - Date.now()) / 1000));
    const cls = bonus.aggressive ? 'steal' : (bonus.malus ? 'malus' : 'bonus');
    // No solo color: el icono marca ademas si conviene (▲) o perjudica (▼/⚔)
    const icon = bonus.aggressive ? '⚔' : (bonus.malus ? '▼' : '▲');
    return `<span class="bonus-badge ${cls}"><span class="bonus-ring"></span><span class="bonus-label">${icon} ${bonus.label}</span><span class="bonus-secs">${secs}</span></span>`;
}

function stopBonusTick() {
    if (state.bonusTickTimer) { clearInterval(state.bonusTickTimer); state.bonusTickTimer = null; }
}

export function clearActiveBonus() {
    state.activeLetterBonus = null;
    stopBonusTick();
    renderLetters();
}

export function showLetterBonus(data) {
    state.activeLetterBonus = {
        letter: data.letter,
        kind: data.kind,
        value: data.value,
        label: data.label,
        malus: !!data.malus,
        aggressive: !!data.aggressive,
        expiresAt: Date.now() + data.durationMs
    };
    renderLetters();
    stopBonusTick();
    state.bonusTickTimer = setInterval(() => {
        if (!state.activeLetterBonus) return stopBonusTick();
        if (Date.now() >= state.activeLetterBonus.expiresAt) return; // el server manda el expired
        renderLetters();
    }, 1000);
}

export function shuffleLetters() {
    const letters = state.displayLetters;
    for (let i = letters.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    renderLetters();
    vibrate(8);
}

export function renderBuiltWord(animateLast = false) {
    const el = $('built-word');
    if (state.builtWord.length === 0) {
        el.innerHTML = `<span class="placeholder">${BUILDER_HINT}</span>`;
        return;
    }
    const last = state.builtWord.length - 1;
    el.innerHTML = state.builtWord
        .map((l, i) => `<span class="built-letter${animateLast && i === last ? ' new' : ''}">${l}</span>`)
        .join('');
}

export function addBuiltLetter(letter) {
    state.builtWord.push(letter);
    renderBuiltWord(true);
}

export function backspaceBuilt() {
    if (state.builtWord.length === 0) return;
    state.builtWord.pop();
    renderBuiltWord();
    vibrate(8);
}

export function clearBuilt() {
    state.builtWord = [];
    renderBuiltWord();
}

export function submitBuild() {
    const word = state.builtWord.join('').toLowerCase();
    if (word.length < 3) {
        showFeedback('Mínimo 3 letras', 'invalid');
        return;
    }
    state.socket.emit('submitWord', { word });
}

export function handleKeyboardKey(e) {
    // Con la ficha de informacion abierta, Escape la cierra
    if (isInfoOpen()) {
        if (e.key === 'Escape') {
            e.preventDefault();
            toggleInfo(false);
        }
        return;
    }
    // Con el dialogo abierto, Escape cancela y el resto no llega al juego
    if (isConfirmOpen()) {
        if (e.key === 'Escape') {
            e.preventDefault();
            state.closeConfirm(false);
        }
        return;
    }
    if (!$('game-view').classList.contains('active')) return;
    const key = e.key;
    if (key === 'Backspace') {
        e.preventDefault();
        backspaceBuilt();
        return;
    }
    if (key === 'Enter') {
        e.preventDefault();
        submitBuild();
        return;
    }
    if (key === 'Escape') {
        e.preventDefault();
        clearBuilt();
        return;
    }
    // Any other single character (incl. accented, e.g. "á") whose canonical
    // form is a rack letter builds the word.
    if (key.length === 1) {
        const cl = canonicalLetter(key);
        if (cl.length === 1 && /[a-zñ]/i.test(cl)) {
            if (state.rackLetters.includes(cl)) {
                addBuiltLetter(key.toUpperCase());
                animateTilePress(findTile(key));
            } else {
                showFeedback('Esa letra no está en el tablero', 'invalid');
            }
            e.preventDefault();
        }
    }
}
