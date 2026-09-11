-- Palabrejo: amistades entre usuarios registrados

-- Una fila por relacion, guardada en el sentido en que se pidio. Los amigos de
-- X son las filas aceptadas donde X es requester o addressee, asi que no hace
-- falta duplicar la relacion ni mantener dos filas en sincronia.
CREATE TABLE IF NOT EXISTS friendships (
    requester_id INT NOT NULL,
    addressee_id INT NOT NULL,
    status ENUM('pending', 'accepted') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP NULL,
    PRIMARY KEY (requester_id, addressee_id),
    INDEX idx_addressee (addressee_id, status),
    INDEX idx_requester (requester_id, status),
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
