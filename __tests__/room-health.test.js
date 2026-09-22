const {
    collectStaleRooms, collectIdlePlayers,
    WAITING_HOST_TTL_MS, AFK_WARN_MS
} = require('../lib/room-health');

// --- collectStaleRooms ---
describe('collectStaleRooms', () => {
    const now = Date.now();

    test('devuelve salas waiting sin actividad del host pasada la ventana', () => {
        const rooms = {
            AAAA: { code: 'AAAA', gameState: 'waiting', createdAt: now - (WAITING_HOST_TTL_MS + 5000) },
            BBBB: { code: 'BBBB', gameState: 'waiting', lastHostActivity: now - (WAITING_HOST_TTL_MS + 5000) },
            CCCC: { code: 'CCCC', gameState: 'waiting', lastHostActivity: now - 1000 },
            DDDD: { code: 'DDDD', gameState: 'playing', createdAt: now - (WAITING_HOST_TTL_MS + 5000) }
        };
        expect(collectStaleRooms(rooms, now).sort()).toEqual(['AAAA', 'BBBB']);
    });

    test('una sala waiting recien creada o tocada por el host no se considera huerfana', () => {
        const rooms = {
            FFFF: { code: 'FFFF', gameState: 'waiting', createdAt: now - 500 },
            GGGG: { code: 'GGGG', gameState: 'waiting', lastHostActivity: now - 50 },
            HHHH: { code: 'HHHH', gameState: 'waiting' }
        };
        expect(collectStaleRooms(rooms, now)).toEqual([]);
    });

    test('las partidas en curso nunca se barren por aqui (la gracia es otra)', () => {
        const rooms = {
            IIII: { code: 'IIII', gameState: 'playing', createdAt: now - (WAITING_HOST_TTL_MS * 10) },
            JJJJ: { code: 'JJJJ', gameState: 'rest', createdAt: now - (WAITING_HOST_TTL_MS * 10) }
        };
        expect(collectStaleRooms(rooms, now)).toEqual([]);
    });
});

// --- collectIdlePlayers ---
describe('collectIdlePlayers', () => {
    const now = Date.now();

    test('avisa a quien lleva mas de la ventana sin responder y aun no avisado', () => {
        const room = {
            gameState: 'waiting',
            players: [
                { id: 'p1', lastSeen: now, afkWarned: false },
                { id: 'p2', lastSeen: now - (AFK_WARN_MS + 1000), afkWarned: false },
                { id: 'p3', lastSeen: now - (AFK_WARN_MS + 1000), afkWarned: true },
                { id: 'p4', lastSeen: now - (AFK_WARN_MS + 1000), disconnected: true }
            ]
        };
        expect(collectIdlePlayers(room, now).map(p => p.id)).toEqual(['p2']);
    });

    test('solo aplica a salas en waiting (jugador en gracia de reconexion no cuenta)', () => {
        const playing = {
            gameState: 'playing',
            players: [{ id: 'p1', lastSeen: now - (AFK_WARN_MS + 1000), afkWarned: false, disconnected: true }]
        };
        const rest = {
            gameState: 'rest',
            players: [{ id: 'p2', lastSeen: now - (AFK_WARN_MS + 1000), afkWarned: false }]
        };
        expect(collectIdlePlayers(playing, now)).toEqual([]);
        expect(collectIdlePlayers(rest, now)).toEqual([]);
    });

    test('sin jugadores o sin sala no avisa a nadie', () => {
        expect(collectIdlePlayers(null, now)).toEqual([]);
        expect(collectIdlePlayers({ gameState: 'waiting', players: [] }, now)).toEqual([]);
    });
});