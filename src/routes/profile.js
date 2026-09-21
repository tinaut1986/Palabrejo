function registerProfileRoutes(app, { getDbPool }) {
    app.get('/api/profile/:username', async (req, res) => {
        try {
            const [rows] = await getDbPool().query(`
                SELECT u.username, u.created_at,
                       us.games_played, us.games_won, us.total_words,
                       us.total_score, us.best_score, us.favorite_words
                FROM users u
                LEFT JOIN user_stats us ON u.id = us.user_id
                WHERE u.username = ?
            `, [req.params.username]);

            if (rows.length === 0) {
                return res.status(404).json({ error: 'Usuario no encontrado.' });
            }

            const profile = rows[0];
            const avgScore = profile.games_played > 0
                ? (profile.total_score / profile.games_played).toFixed(1)
                : 0;

            res.json({
                username: profile.username,
                created_at: profile.created_at,
                games_played: profile.games_played || 0,
                games_won: profile.games_won || 0,
                total_words: profile.total_words || 0,
                total_score: profile.total_score || 0,
                best_score: profile.best_score || 0,
                avg_score: parseFloat(avgScore),
                favorite_words: profile.favorite_words || []
            });
        } catch (error) {
            console.error("Profile error:", error);
            res.status(500).json({ error: 'Error del servidor.' });
        }
    });
}

module.exports = { registerProfileRoutes };
