// Estado compartido de la app y utilidades de UI mínimas usadas por todos
// los demás módulos. Un solo objeto mutable (no `let` exportados sueltos):
// los módulos ES exportan bindings de solo lectura, así que reasignar un
// `let` importado desde otro fichero no funcionaría. Mutar una propiedad de
// `state` sí, y es el mismo patrón que ya usaba el código como una única
// IIFE (issue #7, pasada 4).
export const state = {
    socket: null,
    currentUser: null, // { username, token } o null si se juega como invitado
    guestName: '',      // nombre en uso cuando se juega como invitado
    currentRoom: null,
    isHost: false,
    resumeToken: null,
    roundTimer: null,
    timeLeft: 0,
    nextTimer: null,
    restTimer: null,
    roundScore: 0, // puntos de la ronda en curso (mío)
    lastQrUrl: null, // ultimo QR pintado, para no regenerarlo sin motivo
    pendingRoom: false, // esperando que el servidor confirme sala creada/unida
    myWords: [],
    latestWordKey: null,
    builtWord: [],
    rackLetters: [],
    displayLetters: [],
    activeLetterBonus: null,
    bonusTickTimer: null,
    myTotalScore: 0,
    myRank: '-',
    profileReturnView: 'lobby-view',
    profileUsername: null,
    friendsData: { me: null, friends: [], incoming: [], outgoing: [] },
    compareMetric: 'total_score',
    closeConfirm: null
};

export const $ = id => document.getElementById(id);

export const views = ['setup-view', 'lobby-view', 'room-browser-view', 'waiting-room-view', 'game-view', 'round-results-view', 'game-over-view', 'profile-view', 'friends-view'];

export function showView(viewId) {
    views.forEach(v => $(v).classList.remove('active'));
    $(viewId).classList.add('active');
}

export function showError(elementId, msg) {
    $(elementId).textContent = msg;
    setTimeout(() => { $(elementId).textContent = ''; }, 4000);
}

export function showFeedback(msg, type) {
    const el = $('word-feedback');
    el.textContent = msg;
    el.className = `feedback ${type}`;
    setTimeout(() => { el.className = 'feedback hidden'; }, 2000);
}

export function flashElement(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 500);
}

export function shakeElement(el) {
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 450);
}

// Vibración corta en móvil como refuerzo táctil (se ignora sin soporte)
export function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}

// Al cambiar, el número da un pequeño salto para que se note
export function setPill(id, value) {
    const el = $(id);
    if (!el) return;
    const next = String(value);
    if (el.textContent === next) return;
    el.textContent = next;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
}

// Misma normalizacion que el server: public/js/shared/normalize.js es el
// UNICO sitio con esta logica (issue #7).
export const canonicalLetter = window.normalizeForMatch;

// Nombre con el que entrar a las salas
export function playerDisplayName() {
    return state.currentUser ? state.currentUser.username : state.guestName;
}

// Hay partida abierta mientras estemos en una sala que no ha terminado
export function hasOpenGame() {
    return !!state.currentRoom && state.currentRoom.gameState !== 'finished';
}
