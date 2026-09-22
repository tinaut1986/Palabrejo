// Salud de las salas en espera (issue #15). Funciones PURAS: el servidor les
// pasa el estado en memoria y ellas deciden sin tocar sockets ni timers, igual
// que el resto de la logica de lib/ — asi se pueden testear sin arrancar nada.

// Ventana de actividad minima del host en una sala waiting (misma que la
// gracia de reconexion RESUME_GRACE_MS): pasada sin que el host haga nada, la
// sala se considera huerfana y se elimina (y su codigo se libera).
const WAITING_HOST_TTL_MS = 2 * 60 * 1000;

// Espera antes de avisar a un jugador de la sala de espera por no responder.
const AFK_WARN_MS = 60 * 1000;

// Una peticion de traspaso de host sin respuesta del host caduca sola.
const HOST_REQUEST_TTL_MS = 30 * 1000;

// Salas waiting que llevan mas de WAITING_HOST_TTL_MS sin actividad del host.
// El host la abandono (cerro el navegador sin desconexion limpia, se quedo
// dormido...) y el codigo queda quemado para siempre mientras viva el proceso:
// el sweep las elimina y libera el codigo. Las salas en playing/rest no
// entran: ahi el problema se gestiona con la gracia de reconexion de la sala.
function collectStaleRooms(rooms, now = Date.now()) {
    const stale = [];
    for (const [code, room] of Object.entries(rooms)) {
        if (!room || room.gameState !== 'waiting') continue;
        const lastHost = room.lastHostActivity ?? room.createdAt ?? now;
        if (now - lastHost > WAITING_HOST_TTL_MS) stale.push(code);
    }
    return stale;
}

// Jugadores conectados de una sala waiting que llevan demasiado sin enviar
// nada y aun no han recibido el aviso (p.afkWarned marca que ya se les aviso,
// para no spam). Los desconectados no cuentan; y a los de playing/rest no se
// les toca aqui (el sweep solo mira waiting, de modo que un jugador en gracia
// de reconexion nunca se considera "huerfano").
function collectIdlePlayers(room, now = Date.now()) {
    if (!room || room.gameState !== 'waiting' || !Array.isArray(room.players)) return [];
    return room.players.filter(p =>
        p && !p.disconnected && !p.afkWarned && now - (p.lastSeen ?? now) > AFK_WARN_MS
    );
}

module.exports = {
    WAITING_HOST_TTL_MS, AFK_WARN_MS, HOST_REQUEST_TTL_MS,
    collectStaleRooms, collectIdlePlayers
};