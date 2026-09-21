function registerFriendsRoutes(app, { getDbPool, verifySession }) {
    // Todas estas rutas exigen sesion: la identidad sale del token, nunca de
    // un nombre que mande el cliente.
    async function requireSession(req, res, next) {
        const header = req.get('Authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : req.body?.token;
        const session = await verifySession(token);
        if (!session) return res.status(401).json({ error: 'Sesión no válida o caducada.' });
        req.session = session;
        next();
    }

    const STATS_COLUMNS = `
        COALESCE(us.games_played, 0) AS games_played,
        COALESCE(us.games_won, 0) AS games_won,
        COALESCE(us.total_words, 0) AS total_words,
        COALESCE(us.total_score, 0) AS total_score,
        COALESCE(us.best_score, 0) AS best_score
    `;

    function withAverage(row) {
        const games = Number(row.games_played) || 0;
        return {
            username: row.username,
            games_played: games,
            games_won: Number(row.games_won) || 0,
            total_words: Number(row.total_words) || 0,
            total_score: Number(row.total_score) || 0,
            best_score: Number(row.best_score) || 0,
            avg_score: games > 0 ? Math.round((Number(row.total_score) / games) * 10) / 10 : 0
        };
    }

    // Amigos aceptados y solicitudes en ambos sentidos, con estadisticas para
    // poder comparar sin una segunda llamada
    app.get('/api/friends', requireSession, async (req, res) => {
        const me = req.session.userId;
        const dbPool = getDbPool();
        try {
            const [rows] = await dbPool.query(`
                SELECT u.username, f.status, ${STATS_COLUMNS},
                       CASE WHEN f.requester_id = ? THEN 'out' ELSE 'in' END AS direction
                FROM friendships f
                JOIN users u ON u.id = IF(f.requester_id = ?, f.addressee_id, f.requester_id)
                LEFT JOIN user_stats us ON us.user_id = u.id
                WHERE f.requester_id = ? OR f.addressee_id = ?
                ORDER BY u.username
            `, [me, me, me, me]);

            const [mine] = await dbPool.query(`
                SELECT u.username, ${STATS_COLUMNS}
                FROM users u LEFT JOIN user_stats us ON us.user_id = u.id
                WHERE u.id = ?
            `, [me]);

            res.json({
                me: withAverage(mine[0]),
                friends: rows.filter(r => r.status === 'accepted').map(withAverage),
                incoming: rows.filter(r => r.status === 'pending' && r.direction === 'in').map(r => r.username),
                outgoing: rows.filter(r => r.status === 'pending' && r.direction === 'out').map(r => r.username)
            });
        } catch (error) {
            console.error("Friends error:", error);
            res.status(500).json({ error: 'Error del servidor.' });
        }
    });

    // Localiza al otro usuario y la relacion existente, en el sentido que sea
    async function findRelation(me, username) {
        const dbPool = getDbPool();
        const [users] = await dbPool.query('SELECT id, username FROM users WHERE username = ?', [username]);
        if (users.length === 0) return { missing: true };
        const other = users[0];
        if (other.id === me) return { self: true };
        const [rows] = await dbPool.query(
            `SELECT requester_id, addressee_id, status FROM friendships
             WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
            [me, other.id, other.id, me]
        );
        return { other, relation: rows[0] || null };
    }

    app.post('/api/friends/request', requireSession, async (req, res) => {
        const me = req.session.userId;
        const username = String(req.body?.username || '').trim();
        if (!username) return res.status(400).json({ error: 'Indica un nombre de usuario.' });

        try {
            const { missing, self, other, relation } = await findRelation(me, username);
            if (missing) return res.status(404).json({ error: `No existe ningún jugador llamado "${username}".` });
            if (self) return res.status(400).json({ error: 'No puedes añadirte a ti mismo.' });

            if (relation) {
                if (relation.status === 'accepted') {
                    return res.status(409).json({ error: `Ya sois amigos.` });
                }
                // Si el otro ya te habia invitado, pedirlo equivale a aceptar
                if (relation.addressee_id === me) {
                    await getDbPool().query(
                        `UPDATE friendships SET status = 'accepted', responded_at = NOW()
                         WHERE requester_id = ? AND addressee_id = ?`,
                        [other.id, me]
                    );
                    return res.json({ status: 'accepted' });
                }
                return res.status(409).json({ error: 'Ya le enviaste una solicitud.' });
            }

            await getDbPool().query(
                'INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)',
                [me, other.id]
            );
            res.json({ status: 'pending' });
        } catch (error) {
            console.error("Friend request error:", error);
            res.status(500).json({ error: 'Error del servidor.' });
        }
    });

    app.post('/api/friends/accept', requireSession, async (req, res) => {
        const me = req.session.userId;
        const username = String(req.body?.username || '').trim();
        try {
            const { missing, other, relation } = await findRelation(me, username);
            if (missing) return res.status(404).json({ error: 'Usuario no encontrado.' });
            // Solo se acepta lo que otro te ha pedido
            if (!relation || relation.status !== 'pending' || relation.addressee_id !== me) {
                return res.status(404).json({ error: 'No hay ninguna solicitud de ese jugador.' });
            }
            await getDbPool().query(
                `UPDATE friendships SET status = 'accepted', responded_at = NOW()
                 WHERE requester_id = ? AND addressee_id = ?`,
                [other.id, me]
            );
            res.json({ status: 'accepted' });
        } catch (error) {
            console.error("Friend accept error:", error);
            res.status(500).json({ error: 'Error del servidor.' });
        }
    });

    // Sirve para rechazar, cancelar una solicitud propia y eliminar a un amigo
    app.post('/api/friends/remove', requireSession, async (req, res) => {
        const me = req.session.userId;
        const username = String(req.body?.username || '').trim();
        try {
            const { missing, other, relation } = await findRelation(me, username);
            if (missing) return res.status(404).json({ error: 'Usuario no encontrado.' });
            if (!relation) return res.status(404).json({ error: 'No hay ninguna relación con ese jugador.' });
            await getDbPool().query(
                `DELETE FROM friendships
                 WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
                [me, other.id, other.id, me]
            );
            res.json({ status: 'removed' });
        } catch (error) {
            console.error("Friend remove error:", error);
            res.status(500).json({ error: 'Error del servidor.' });
        }
    });
}

module.exports = { registerFriendsRoutes };
