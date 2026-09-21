// Normalizacion canonica de letras/palabras, compartida de verdad entre
// servidor y cliente: este MISMO fichero lo sirve Express como estatico
// (public/js/shared/normalize.js) y lo hace `require` lib/game-logic.js. Sin
// esto habia dos copias identicas (normalizeForMatch en el server,
// canonicalLetter en el cliente) que solo por casualidad hacian lo mismo.
//
// Formato canonico: sin acentos/marcas, en minusculas, con la Ñ como letra
// propia (no se confunde con N). P.ej. "café" -> "cafe", "moño" -> "moño".
function normalizeForMatch(str) {
    return str.normalize('NFD')
        .replace(/ñ/gi, 'ñ')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase();
}

// CommonJS (server, tests) y navegador (script clasico, sin bundler) a la vez.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeForMatch };
} else {
    // eslint-disable-next-line no-undef
    window.normalizeForMatch = normalizeForMatch;
}
