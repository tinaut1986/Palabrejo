-- Palabrejo: permite invalidar sesiones abiertas

-- Los tokens de sesion van firmados y no se consultan en base de datos, asi
-- que por si solos no se pueden revocar. Incluyendo esta version en el token y
-- comparandola al validarlo, incrementarla caduca de golpe todas las sesiones
-- del usuario (por ejemplo al cambiarle la contrasena).
ALTER TABLE users ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0;
