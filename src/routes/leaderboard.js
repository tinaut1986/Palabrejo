function registerLeaderboardRoutes(app, { getDbPool }) {
    app.get('/api/leaderboard', async (req, res) => {
        try {
            const [rows] = await getDbPool().query(`
                SELECT u.username,
                       us.games_played, us.games_won, us.total_words,
                       us.total_score, us.best_score
                FROM users u
                JOIN user_stats us ON u.id = us.user_id
                WHERE us.games_played > 0
                ORDER BY us.total_score DESC
                LIMIT 50
            `);
            res.json(rows);
        } catch (error) {
            console.error("Leaderboard error:", error);
            res.status(500).json({ error: 'Error del servidor.' });
        }
    });
}

module.exports = { registerLeaderboardRoutes };
