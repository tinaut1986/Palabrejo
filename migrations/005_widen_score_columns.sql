-- game_players.score y user_stats.best_score eran TINYINT UNSIGNED (max 255):
-- una partida normal ya podia superarlo, y con los multiplicadores de bonus
-- en letras (x2/x3) es facil. Se ensanchan a INT UNSIGNED, igual que
-- user_stats.total_score, con el que se suman.
ALTER TABLE game_players MODIFY COLUMN score INT UNSIGNED DEFAULT 0;
ALTER TABLE user_stats MODIFY COLUMN best_score INT UNSIGNED DEFAULT 0;
