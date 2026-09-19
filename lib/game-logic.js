// --- GAME LOGIC ---
// Pure functions and constants extracted for reusability and testing.

// --- LETTER POOL ---
// Weighted by frequency in Spanish
const LETTER_POOL = [
    'A','A','A','A','A','A','A','A',
    'B','B',
    'C','C','C',
    'D','D','D',
    'E','E','E','E','E','E','E','E','E','E',
    'F','F',
    'G','G',
    'H','H',
    'I','I','I','I','I','I','I',
    'J',
    'K',
    'L','L','L','L',
    'M','M','M',
    'N','N','N','N','N','N',
    'Ñ','Ñ',
    'O','O','O','O','O','O','O','O',
    'P','P','P',
    'Q',
    'R','R','R','R','R','R',
    'S','S','S','S','S','S','S',
    'T','T','T','T','T',
    'U','U','U','U',
    'V','V',
    'W',
    'X',
    'Y','Y',
    'Z'
];

const MIN_LETTERS = 6;
const MAX_LETTERS = 8;
const DEFAULT_ROUNDS = 5;
const DEFAULT_MAX_PLAYERS = 8;
const MIN_WORD_LENGTH = 3;
const DEFAULT_ROUND_TIME = 90;

// Descanso entre partidas completas
const NEXT_GAME_DELAY_MS = 20 * 1000;
const MIN_VOWELS = 2;
const VOWELS = ['A', 'E', 'I', 'O', 'U'];

// Un tablero sin palabras jugables no tiene gracia
const MIN_PLAYABLE_WORDS = 30;
const MAX_LETTER_ROLL_ATTEMPTS = 20;

// Un PALABREJO es la palabra que usa todas las letras del tablero
const PALABREJO_BONUS = 15;

// Modos de juego. En 'normal' una palabra la puede enviar cualquiera; en
// 'exclusivo' se la queda quien la manda primero y a los demas ya no les vale.
const GAME_MODES = ['normal', 'exclusivo'];
const DEFAULT_GAME_MODE = 'normal';

function normalizeGameMode(mode) {
    return GAME_MODES.includes(mode) ? mode : DEFAULT_GAME_MODE;
}

// --- BONUS/CASTIGO EN LETRAS DEL TABLERO ---
// De vez en cuando una letra del tablero se marca con un efecto temporal que
// modifica los puntos de la palabra que la use. Se consume con el primer uso
// (de cualquier jugador) o desaparece solo si nadie la usa a tiempo.
const BONUS_TYPES = {
    multiply: { values: [2, 3], malus: false, aggressive: false, label: v => `x${v}` },
    add:      { values: [3, 5, 8], malus: false, aggressive: false, label: v => `+${v}` },
    divide:   { values: [2, 3], malus: true, aggressive: false, label: v => `÷${v}` },
    subtract: { values: [3, 5, 8], malus: true, aggressive: false, label: v => `-${v}` },
    // "Robo": ademas de puntuar para quien la usa, resta al lider de la ronda.
    // Es el unico tipo que perjudica directamente a otro jugador.
    steal:    { values: [5, 8], malus: false, aggressive: true, label: v => `robo ${v}` }
};
const BONUS_KINDS = Object.keys(BONUS_TYPES);

const BONUS_MIN_SPAWN_DELAY_MS = 6 * 1000;
const BONUS_MAX_SPAWN_DELAY_MS = 14 * 1000;
const BONUS_MIN_DURATION_MS = 6 * 1000;
const BONUS_MAX_DURATION_MS = 12 * 1000;

function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

// Elige tipo y valor al azar para un nuevo bonus/castigo.
function rollBonus() {
    const kind = BONUS_KINDS[Math.floor(Math.random() * BONUS_KINDS.length)];
    const def = BONUS_TYPES[kind];
    const value = def.values[Math.floor(Math.random() * def.values.length)];
    return { kind, value, malus: def.malus, aggressive: def.aggressive, label: def.label(value) };
}

// Aplica el modificador a los puntos base de la palabra. Nunca deja una
// palabra en negativo: en el peor de los casos vale 0, no resta del total
// acumulado antes de jugarla.
function applyBonus(basePoints, bonus) {
    if (!bonus) return basePoints;
    switch (bonus.kind) {
        case 'multiply': return basePoints * bonus.value;
        case 'add': return basePoints + bonus.value;
        case 'divide': return Math.max(0, Math.floor(basePoints / bonus.value));
        case 'subtract': return Math.max(0, basePoints - bonus.value);
        case 'steal': return basePoints + bonus.value;
        default: return basePoints;
    }
}

// True when the word uses all the rack letters at least once. Letters on the
// rack are distinct, so it is enough to check that none is missing; repeating
// a letter inside the word is allowed, as it is anywhere else in the game.
function isPalabrejo(word, letters) {
    if (!letters || letters.length === 0) return false;
    const used = new Set(normalizeForMatch(word));
    return letters.every(l => used.has(normalizeForMatch(l)));
}

// Scoring: longer words are worth exponentially more, and un PALABREJO (usar
// todas las letras) paga un extra fijo encima: es la jugada dificil de verdad.
function calculateScore(word, letters) {
    const len = word.length;
    let score;
    if (len === 3) score = 1;
    else if (len === 4) score = 2;
    else if (len === 5) score = 4;
    else if (len === 6) score = 7;
    else score = 10; // 7+ letters
    if (isPalabrejo(word, letters)) score += PALABREJO_BONUS;
    return score;
}

// Canonical form for comparisons: accents/marks are stripped but Ñ is kept as a
// distinct letter (e.g. "café" -> "cafe", "moño" -> "moño", "Ñoño" -> "ñoño").
function normalizeForMatch(str) {
    return str.normalize('NFD')
        .replace(/n\u0303/gi, 'ñ')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function sanitizeGuestName(name) {
    const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
    return clean.length >= 2 ? clean : 'Invitado';
}

// Generate `count` DISTINCT letters (each letter appears once on the rack and
// can be used as many times as the player wants). At least MIN_VOWELS vowels.
function generateLetters(count) {
    const letters = [];
    const used = new Set();
    const pool = [...LETTER_POOL];
    let guard = 0;
    while (letters.length < count && guard < 500) {
        guard++;
        const idx = Math.floor(Math.random() * pool.length);
        const l = pool[idx];
        if (!used.has(l)) {
            used.add(l);
            letters.push(l);
        }
    }
    const remaining = Array.from(new Set(LETTER_POOL)).filter(l => !used.has(l));
    while (letters.length < count && remaining.length) {
        const i = Math.floor(Math.random() * remaining.length);
        const l = remaining.splice(i, 1)[0];
        used.add(l);
        letters.push(l);
    }
    const vowelSet = new Set(VOWELS);
    let vowels = letters.filter(l => vowelSet.has(l)).length;
    const shuffledVowels = [...VOWELS].sort(() => Math.random() - 0.5);
    let vi = 0;
    for (let i = 0; i < letters.length && vowels < MIN_VOWELS; i++) {
        if (vowelSet.has(letters[i])) continue;
        const cand = shuffledVowels[vi++ % shuffledVowels.length];
        if (!used.has(cand)) {
            used.delete(letters[i]);
            letters[i] = cand;
            used.add(cand);
            vowels++;
        }
    }
    return letters;
}

function isWordValid(word, letters, { validWordsCanonical, minLength = MIN_WORD_LENGTH } = {}) {
    const wordLower = word.toLowerCase();
    if (wordLower.length < minLength) return false;
    const canonical = normalizeForMatch(wordLower);
    if (!validWordsCanonical || !validWordsCanonical.has(canonical)) return false;
    const letterSet = new Set(letters.map(l => normalizeForMatch(l)));
    for (const c of canonical) {
        if (!letterSet.has(c)) return false;
    }
    return true;
}

function countPlayableWords(letters, { validWordsCanonical, minLength = MIN_WORD_LENGTH } = {}) {
    if (!validWordsCanonical || validWordsCanonical.size === 0) return 0;
    const letterSet = new Set(letters.map(l => normalizeForMatch(l)));
    let count = 0;
    for (const canonical of validWordsCanonical) {
        if (canonical.length < minLength) continue;
        let ok = true;
        for (let i = 0; i < canonical.length; i++) {
            if (!letterSet.has(canonical[i])) { ok = false; break; }
        }
        if (ok) count++;
    }
    return count;
}

// Todas las palabras (con su grafia real, tildes incluidas) jugables con un
// reparto de letras dado. A diferencia de countPlayableWords, que solo cuenta
// para decidir si un reparto es bueno, esta devuelve la lista: se usa al
// terminar la ronda para mostrar las palabras que a cada jugador se le
// escaparon.
function getPlayableWords(letters, { validWordsCache, minLength = MIN_WORD_LENGTH } = {}) {
    if (!validWordsCache || validWordsCache.size === 0) return [];
    const letterSet = new Set(letters.map(l => normalizeForMatch(l)));
    const words = [];
    for (const word of validWordsCache) {
        if (word.length < minLength) continue;
        const canonical = normalizeForMatch(word);
        let ok = true;
        for (let i = 0; i < canonical.length; i++) {
            if (!letterSet.has(canonical[i])) { ok = false; break; }
        }
        if (ok) words.push(word);
    }
    return words;
}

// Letras distintas (sin acentos, Ñ aparte) que usa una palabra: sirve tanto
// para indexar el diccionario por tamaño de tablero como para derivar un
// reparto de letras a partir de una palabra real.
function distinctLettersOf(word) {
    const canonical = normalizeForMatch(word);
    return Array.from(new Set(canonical.split(''))).map(c => c.toUpperCase());
}

// Indice palabra -> letras distintas, agrupado por cuantas letras distintas
// tiene (solo las que caben en un tablero, MIN_LETTERS..MAX_LETTERS). Se usa
// para garantizar que SIEMPRE hay un PALABREJO posible: si el reparto sale de
// las letras distintas de una palabra real, esa palabra ya es un PALABREJO.
function buildWordsByDistinctCount(words, { minLetters = MIN_LETTERS, maxLetters = MAX_LETTERS } = {}) {
    const map = {};
    for (const word of words) {
        const letters = distinctLettersOf(word);
        if (letters.length < minLetters || letters.length > maxLetters) continue;
        if (!map[letters.length]) map[letters.length] = [];
        map[letters.length].push(letters);
    }
    return map;
}

// Un tablero sin palabra "PALABREJO" posible es un tablero incompleto: se
// reparte a partir de las letras distintas de una palabra real del
// diccionario, de forma que esa palabra sea siempre jugable como PALABREJO.
// Entre varias candidatas del mismo tamaño se elige la que deje mas palabras
// jugables en total.
// Cuando el reparto sale de las letras de una palabra real (ver mas abajo),
// esas letras salen en el orden en que aparecen en la palabra: sin barajar,
// el propio tablero deja medio leido el PALABREJO. Se mezclan antes de
// mandarlas al cliente.
function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function selectPlayableLetters(count, {
    validWordsCanonical,
    wordsByDistinctCount,
    maxAttempts = MAX_LETTER_ROLL_ATTEMPTS,
    minWords = MIN_PLAYABLE_WORDS,
    generate = generateLetters
} = {}) {
    const candidates = wordsByDistinctCount && wordsByDistinctCount[count];
    if (candidates && candidates.length > 0) {
        let best = null;
        const attempts = Math.min(maxAttempts, candidates.length);
        const tried = new Set();
        for (let i = 0; i < attempts; i++) {
            let idx = Math.floor(Math.random() * candidates.length);
            if (tried.size < candidates.length) {
                while (tried.has(idx)) idx = Math.floor(Math.random() * candidates.length);
            }
            tried.add(idx);
            const letters = candidates[idx];
            const words = countPlayableWords(letters, { validWordsCanonical });
            if (!best || words > best.words) best = { letters, words };
            if (words >= minWords) break;
        }
        return shuffleArray(best.letters);
    }

    // Sin diccionario indexado (p.ej. en tests unitarios sueltos): se cae al
    // reparto aleatorio de siempre, sin garantia de PALABREJO.
    let best = null;
    for (let i = 0; i < maxAttempts; i++) {
        const letters = generate(count);
        const words = countPlayableWords(letters, { validWordsCanonical });
        if (!best || words > best.words) best = { letters, words };
        if (words >= minWords) break;
    }
    return best.letters;
}

module.exports = {
    LETTER_POOL, MIN_LETTERS, MAX_LETTERS, DEFAULT_ROUNDS, DEFAULT_MAX_PLAYERS,
    MIN_WORD_LENGTH, DEFAULT_ROUND_TIME, NEXT_GAME_DELAY_MS, MIN_VOWELS, VOWELS,
    MIN_PLAYABLE_WORDS, MAX_LETTER_ROLL_ATTEMPTS, PALABREJO_BONUS,
    GAME_MODES, DEFAULT_GAME_MODE, normalizeGameMode,
    calculateScore, isPalabrejo, normalizeForMatch, sanitizeGuestName,
    generateLetters, isWordValid, countPlayableWords, getPlayableWords, selectPlayableLetters,
    distinctLettersOf, buildWordsByDistinctCount,
    BONUS_TYPES, BONUS_KINDS,
    BONUS_MIN_SPAWN_DELAY_MS, BONUS_MAX_SPAWN_DELAY_MS,
    BONUS_MIN_DURATION_MS, BONUS_MAX_DURATION_MS,
    rollBonus, applyBonus
};