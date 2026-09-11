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

// Scoring: longer words are worth exponentially more
function calculateScore(word) {
    const len = word.length;
    if (len === 3) return 1;
    if (len === 4) return 2;
    if (len === 5) return 4;
    if (len === 6) return 7;
    return 10; // 7+ letters
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

function selectPlayableLetters(count, { validWordsCanonical, maxAttempts = MAX_LETTER_ROLL_ATTEMPTS, minWords = MIN_PLAYABLE_WORDS, generate = generateLetters } = {}) {
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
    MIN_PLAYABLE_WORDS, MAX_LETTER_ROLL_ATTEMPTS,
    calculateScore, normalizeForMatch, sanitizeGuestName,
    generateLetters, isWordValid, countPlayableWords, selectPlayableLetters
};