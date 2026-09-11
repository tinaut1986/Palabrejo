-- Palabrejo: soporte de sesiones firmadas

-- Ajustes internos del servidor (entre ellos el secreto de firma de sesiones).
-- Vive en la base de datos para que los tokens sigan siendo validos despues de
-- reconstruir el contenedor.
CREATE TABLE IF NOT EXISTS app_settings (
    name VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
