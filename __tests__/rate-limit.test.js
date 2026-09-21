const { createLimiter } = require('../lib/rate-limit');

describe('createLimiter', () => {
    test('cuenta golpes dentro de la ventana', () => {
        const limiter = createLimiter({ windowMs: 1000 });
        expect(limiter.hit('a', 0)).toBe(1);
        expect(limiter.hit('a', 100)).toBe(2);
        expect(limiter.hit('a', 200)).toBe(3);
    });

    test('los golpes fuera de la ventana se olvidan', () => {
        const limiter = createLimiter({ windowMs: 1000 });
        limiter.hit('a', 0);
        limiter.hit('a', 100);
        expect(limiter.hit('a', 2000)).toBe(1); // los dos primeros ya caducaron
    });

    test('claves distintas no se pisan', () => {
        const limiter = createLimiter({ windowMs: 1000 });
        limiter.hit('a', 0);
        limiter.hit('a', 0);
        expect(limiter.count('a', 0)).toBe(2);
        expect(limiter.count('b', 0)).toBe(0);
    });

    test('count no registra golpe (solo consulta)', () => {
        const limiter = createLimiter({ windowMs: 1000 });
        limiter.hit('a', 0);
        expect(limiter.count('a', 0)).toBe(1);
        expect(limiter.count('a', 0)).toBe(1); // no crece por consultar
    });

    test('reset limpia la clave', () => {
        const limiter = createLimiter({ windowMs: 1000 });
        limiter.hit('a', 0);
        limiter.hit('a', 0);
        limiter.reset('a');
        expect(limiter.count('a', 0)).toBe(0);
    });

    test('sweep quita claves ya vacias sin tocar las vivas', () => {
        const limiter = createLimiter({ windowMs: 1000 });
        limiter.hit('viejo', 0);
        limiter.hit('reciente', 5000);
        limiter.sweep(5000);
        expect(limiter.count('viejo', 5000)).toBe(0);
        expect(limiter.count('reciente', 5000)).toBe(1);
    });
});
