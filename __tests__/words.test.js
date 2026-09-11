const {
    countPlayableWords, isWordValid, selectPlayableLetters,
    normalizeForMatch,
    MIN_WORD_LENGTH, MIN_PLAYABLE_WORDS, MIN_LETTERS, MAX_LETTERS
} = require('../lib/game-logic');

// El diccionario real (108648 palabras) se carga desde la BD en jest.setup.js
const dict = () => globalThis.__WORD_DICT__;

// Racks con medidas tomadas con el diccionario real:
//  ['Q','X','W','Z','Y','K','B','C'] -> 0 palabras
//  ['A','E','I','O','U','S','R','T','N'] -> 2757 palabras
const BAD_RACK = ['Q', 'X', 'W', 'Z', 'Y', 'K', 'B', 'C'];
const GOOD_RACK = ['A', 'E', 'I', 'O', 'U', 'S', 'R', 'T', 'N'];

describe('isWordValid (diccionario real)', () => {
    test('palabra real dentro del diccionario', () => {
        expect(isWordValid('hola', ['H', 'O', 'L', 'A'], { validWordsCanonical: dict() })).toBe(true);
        expect(isWordValid('casa', ['C', 'A', 'S'], { validWordsCanonical: dict() })).toBe(true);
    });
    test('palabra demasiado corta o inexistente', () => {
        expect(isWordValid('aa', ['A'], { validWordsCanonical: dict() })).toBe(false);
        expect(isWordValid('zzzz', ['Z'], { validWordsCanonical: dict() })).toBe(false);
    });
    test('requiere que todas las letras esten en el rack', () => {
        expect(isWordValid('piscina', ['P', 'I', 'S', 'C', 'N'], { validWordsCanonical: dict() })).toBe(false);
        expect(isWordValid('piscina', ['P', 'I', 'S', 'C', 'N', 'A'], { validWordsCanonical: dict() })).toBe(true);
    });
    test('con/sin tilde son la misma palabra; ñ es distinta de n', () => {
        expect(normalizeForMatch('café')).toBe('cafe');
        expect(isWordValid('café', ['C', 'A', 'F', 'E'], { validWordsCanonical: dict() })).toBe(true);
        expect(normalizeForMatch('moño')).toBe('moño');
        expect(normalizeForMatch('moño')).not.toBe('mono');
        expect(isWordValid('moño', ['M', 'O', 'Ñ', 'Ñ'], { validWordsCanonical: dict() })).toBe(true);
        expect(isWordValid('moño', ['M', 'O', 'N'], { validWordsCanonical: dict() })).toBe(false);
    });
});

describe('countPlayableWords (diccionario real)', () => {
    test('una mano mala (0 palabras) fuerza el reroll', () => {
        expect(countPlayableWords(BAD_RACK, { validWordsCanonical: dict() })).toBe(0);
        expect(countPlayableWords(BAD_RACK, { validWordsCanonical: dict() }))
            .toBeLessThan(MIN_PLAYABLE_WORDS);
    });
    test('una mano buena supera de largo el minimo decidido', () => {
        expect(countPlayableWords(GOOD_RACK, { validWordsCanonical: dict() })).toBeGreaterThan(1000);
        expect(countPlayableWords(GOOD_RACK, { validWordsCanonical: dict() }))
            .toBeGreaterThanOrEqual(MIN_PLAYABLE_WORDS);
    });
    test('cuanto mas letras, mas palabras (a misma calidad)', () => {
        const few = countPlayableWords(['A', 'E', 'I'], { validWordsCanonical: dict() });
        const good = countPlayableWords(GOOD_RACK, { validWordsCanonical: dict() });
        const many = countPlayableWords(['A', 'E', 'I', 'O', 'U', 'S', 'R', 'T', 'N', 'L', 'M', 'P', 'D', 'C', 'G', 'B'], { validWordsCanonical: dict() });
        expect(few).toBeLessThan(good);
        expect(good).toBeGreaterThan(0);
        expect(many).toBeGreaterThan(good);
    });
});

describe('selectPlayableLetters (diccionario real)', () => {
    test('elige letras que SI rinden mas que el minimo decidido', () => {
        for (let i = 0; i < 20; i++) {
            const letters = selectPlayableLetters(MIN_LETTERS + (i % (MAX_LETTERS - MIN_LETTERS + 1)), { validWordsCanonical: dict() });
            const words = countPlayableWords(letters, { validWordsCanonical: dict() });
            expect(letters.length).toBeGreaterThanOrEqual(MIN_LETTERS);
            expect(words).toBeGreaterThanOrEqual(MIN_PLAYABLE_WORDS);
        }
    });
    test('nunca se queda en un rack con 0 palabras si hay alternativa', () => {
        const letters = selectPlayableLetters(8, { validWordsCanonical: dict() });
        expect(countPlayableWords(letters, { validWordsCanonical: dict() })).toBeGreaterThan(0);
    });
});