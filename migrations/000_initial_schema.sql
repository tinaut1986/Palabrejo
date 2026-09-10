-- Palabrero: Initial schema

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(20) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS words (
    id INT AUTO_INCREMENT PRIMARY KEY,
    word VARCHAR(50) UNIQUE NOT NULL,
    length TINYINT UNSIGNED NOT NULL,
    INDEX idx_length (length),
    INDEX idx_word (word)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS games (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_code VARCHAR(4) NOT NULL,
    host_user_id INT NULL,
    max_players TINYINT UNSIGNED NOT NULL DEFAULT 8,
    total_rounds TINYINT UNSIGNED NOT NULL DEFAULT 5,
    letters_used VARCHAR(30) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_players (
    id INT AUTO_INCREMENT PRIMARY KEY,
    game_id INT NOT NULL,
    user_id INT NULL,
    guest_name VARCHAR(20) NULL,
    score TINYINT UNSIGNED DEFAULT 0,
    words_found JSON,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_stats (
    user_id INT PRIMARY KEY,
    games_played INT UNSIGNED DEFAULT 0,
    games_won INT UNSIGNED DEFAULT 0,
    total_words INT UNSIGNED DEFAULT 0,
    total_score INT UNSIGNED DEFAULT 0,
    best_score TINYINT UNSIGNED DEFAULT 0,
    favorite_words JSON,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
