// Limitador de ventana deslizante, en memoria, sin dependencias: encaja con
// que el servidor es single-process (issue #3). No pretende ser exacto a
// nivel de milisegundo, solo barato y suficiente para frenar abuso.

// `now` es inyectable para que sea testeable sin temporizadores reales.
function createLimiter({ windowMs }) {
    const hits = new Map(); // key -> timestamps (ms) dentro de la ventana

    function prune(arr, now) {
        while (arr.length && now - arr[0] > windowMs) arr.shift();
    }

    return {
        // Registra un golpe y devuelve cuantos hay en la ventana (incluido este)
        hit(key, now = Date.now()) {
            let arr = hits.get(key);
            if (!arr) { arr = []; hits.set(key, arr); }
            prune(arr, now);
            arr.push(now);
            return arr.length;
        },
        // Cuenta sin registrar golpe (para comprobar antes de decidir)
        count(key, now = Date.now()) {
            const arr = hits.get(key);
            if (!arr) return 0;
            prune(arr, now);
            return arr.length;
        },
        reset(key) {
            hits.delete(key);
        },
        // Evita fuga de memoria en procesos largos: limpia claves inactivas
        sweep(now = Date.now()) {
            for (const [key, arr] of hits) {
                prune(arr, now);
                if (arr.length === 0) hits.delete(key);
            }
        }
    };
}

module.exports = { createLimiter };
