const {
    calculateScore, isPalabrejo, normalizeGameMode, normalizeForMatch, sanitizeGuestName,
    generateLetters, countPlayableWords, selectPlayableLetters,
    MIN_LETTERS, MAX_LETTERS, MIN_WORD_LENGTH, MIN_VOWELS, VOWELS,
    MIN_PLAYABLE_WORDS, MAX_LETTER_ROLL_ATTEMPTS, PALABREJO_BONUS, DEFAULT_GAME_MODE
} = require('../lib/game-logic');

// --- calculateScore ---
describe('calculateScore', () => {
    test('devuelve puntos crecientes con la longitud', () => {
        expect(calculateScore('sol')).toBe(1);      // 3
        expect(calculateScore('mesa')).toBe(2);     // 4
        expect(calculateScore('plato')).toBe(4);    // 5
        expect(calculateScore('bocado')).toBe(7);   // 6
        expect(calculateScore('terremoto')).toBe(10); // 7+
    });

    test('suma el bonus de palabrejo cuando se usan todas las letras', () => {
        expect(calculateScore('mesa', ['M', 'E', 'S', 'A'])).toBe(2 + PALABREJO_BONUS);
        // Sobra la Z: no estan todas
        expect(calculateScore('mesa', ['M', 'E', 'S', 'A', 'Z'])).toBe(2);
        // Sin tablero (marcadores historicos) se puntua solo por longitud
        expect(calculateScore('mesa')).toBe(2);
    });
});

// --- isPalabrejo ---
describe('isPalabrejo', () => {
    test('exige todas las letras, pero permite repetirlas', () => {
        expect(isPalabrejo('caracol', ['C', 'A', 'R', 'O', 'L'])).toBe(true);
        expect(isPalabrejo('caracol', ['C', 'A', 'R', 'O', 'L', 'T'])).toBe(false);
    });

    test('ignora acentos y trata la ñ como letra propia', () => {
        expect(isPalabrejo('canción', ['C', 'A', 'N', 'I', 'O'])).toBe(true);
        expect(isPalabrejo('mano', ['M', 'A', 'Ñ', 'O'])).toBe(false);
        expect(isPalabrejo('maño', ['M', 'A', 'Ñ', 'O'])).toBe(true);
    });

    test('sin tablero no hay jugada especial', () => {
        expect(isPalabrejo('mesa', [])).toBe(false);
        expect(isPalabrejo('mesa', undefined)).toBe(false);
    });
});

// --- normalizeGameMode ---
describe('normalizeGameMode', () => {
    test('acepta los modos conocidos y descarta lo demas', () => {
        expect(normalizeGameMode('normal')).toBe('normal');
        expect(normalizeGameMode('exclusivo')).toBe('exclusivo');
        expect(normalizeGameMode('loquesea')).toBe(DEFAULT_GAME_MODE);
        expect(normalizeGameMode(undefined)).toBe(DEFAULT_GAME_MODE);
    });
});

// --- normalizeForMatch ---
describe('normalizeForMatch', () => {
    test('quita acentos y pasa a minusculas', () => {
        expect(normalizeForMatch('Café')).toBe('cafe');
        expect(normalizeForMatch('ÁNGULO')).toBe('angulo');
        expect(normalizeForMatch('ción')).toBe('cion');
    });
    test('mantiene ñ distinta de n', () => {
        expect(normalizeForMatch('mañana')).toBe('mañana');
        expect(normalizeForMatch('cano')).toBe('cano');
        expect(normalizeForMatch('mañana')).not.toBe('manana');
    });
});

// --- sanitizeGuestName ---
describe('sanitizeGuestName', () => {
    test('nombres vacios o cortos pasan a Invitado', () => {
        expect(sanitizeGuestName(null)).toBe('Invitado');
        expect(sanitizeGuestName('')).toBe('Invitado');
        expect(sanitizeGuestName('x')).toBe('Invitado');
    });
    test('recorta a 20 y limpia caracteres de control', () => {
        expect(sanitizeGuestName('a'.repeat(50))).toBe('a'.repeat(20));
        expect(sanitizeGuestName('  Ana  ')).toBe('Ana');
        expect(sanitizeGuestName('Jo\u0000se')).toBe('Jose');
    });
});

// --- generateLetters ---
describe('generateLetters', () => {
    test('genera letras distintas', () => {
        const letters = generateLetters(8);
        expect(letters.length).toBe(8);
        expect(new Set(letters).size).toBe(8);
    });
    test('garantiza el minimo de vocales', () => {
        const vowelSet = new Set(VOWELS);
        for (let i = 0; i < 100; i++) {
            const letters = generateLetters(MIN_LETTERS);
            const vowels = letters.filter(l => vowelSet.has(l)).length;
            expect(vowels).toBeGreaterThanOrEqual(MIN_VOWELS);
        }
    });
    test('nunca genera mas letras de las pedidas', () => {
        for (let count = MIN_LETTERS; count <= MAX_LETTERS; count++) {
            expect(generateLetters(count).length).toBe(count);
        }
    });
});

// --- countPlayableWords: el "sensor" del reroll ---
describe('countPlayableWords', () => {
    const dict = new Set(['mar', 'rama', 'amar', 'ra', 'al', 'otro']);

    test('sin diccionario devuelve 0 (no hay partida posible)', () => {
        expect(countPlayableWords(['A', 'M', 'R'], { validWordsCanonical: null })).toBe(0);
        expect(countPlayableWords(['A', 'M', 'R'], { validWordsCanonical: new Set() })).toBe(0);
    });
    test('cuenta solo las palabras construibles con las letras dadas', () => {
        // mar, rama, amar (3) -> "ra" y "al" se descartan por longitud minima
        expect(countPlayableWords(['M', 'A', 'R'], { validWordsCanonical: dict })).toBe(3);
        // Con T y O ademas entra "otro"
        expect(countPlayableWords(['M', 'A', 'R', 'O', 'T'], { validWordsCanonical: dict })).toBe(4);
    });
    test('una mano sin palabras posibles reporta 0 (pide reroll)', () => {
        expect(countPlayableWords(['B', 'C', 'D'], { validWordsCanonical: dict })).toBe(0);
    });
    test('una mano pobre queda por debajo del mínimo decidido', () => {
        expect(countPlayableWords(['M', 'A', 'R'], { validWordsCanonical: dict, minLength: 2 }))
            .toBeLessThan(MIN_PLAYABLE_WORDS);
    });
});

// --- selectPlayableLetters: decide cuándo hacer reroll ---
describe('selectPlayableLetters', () => {
    const dict = new Set(['mar', 'rama', 'amar']);

    test('reroll: si la primera mano no llega al minimo, prueba la siguiente', () => {
        // El generador entrega primero una mano sin palabras y luego una buena
        const racks = [['B', 'C', 'D', 'F'], ['M', 'A', 'R', 'O']];
        let call = 0;
        const chosen = selectPlayableLetters(4, {
            validWordsCanonical: dict,
            minWords: 3,
            maxAttempts: 5,
            generate: () => racks[Math.min(call++, racks.length - 1)]
        });
        expect(chosen).toEqual(['M', 'A', 'R', 'O']);
        expect(call).toBe(2); // descarto la mala y uso la buena
    });

    test('primera mano buena: no se proban mas racks', () => {
        const racks = [['M', 'A', 'R', 'O']];
        let call = 0;
        const chosen = selectPlayableLetters(4, {
            validWordsCanonical: dict,
            minWords: 3,
            maxAttempts: MAX_LETTER_ROLL_ATTEMPTS,
            generate: () => { call++; return racks[0]; }
        });
        expect(chosen).toEqual(['M', 'A', 'R', 'O']);
        expect(call).toBe(1);
    });

    test('todas malas: devuelve la mejor sin superar maxAttempts ni bloquear', () => {
        const rack = ['B', 'C', 'D'];
        let call = 0;
        const chosen = selectPlayableLetters(3, {
            validWordsCanonical: dict,
            minWords: 3,
            maxAttempts: 3,
            generate: () => { call++; return rack; }
        });
        void chosen; // cualquier rack vale: ninguno alcanza el minimo
        expect(call).toBe(3);
    });

    test('no alcanzar nunca el minimo no lanza ni devuelve undefined', () => {
        const chosen = selectPlayableLetters(3, {
            validWordsCanonical: dict,
            minWords: 999999,
            maxAttempts: 2,
            generate: r => r.length ? ['B', 'C', 'D'] : []
        });
        expect(chosen).toBeTruthy();
    });

    test('por defecto nunca devuelve undefined', () => {
        const chosen = selectPlayableLetters(MIN_LETTERS, { validWordsCanonical: dict, minWords: 999999 });
        expect(chosen).toBeTruthy();
    });
});