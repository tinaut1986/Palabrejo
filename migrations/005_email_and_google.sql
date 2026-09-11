-- Palabrejo: correo en las cuentas y alta por Google

-- El correo identifica a la persona (sirve para entrar y para enlazar la
-- cuenta de Google con una ya existente). Es NULL en las cuentas antiguas,
-- que se registraron cuando no se pedia, asi que el UNIQUE lo tolera.
ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL;
ALTER TABLE users ADD UNIQUE KEY uniq_email (email);

-- Identificador estable que da Google ("sub"). No usamos el correo para
-- reconocer la cuenta porque el usuario puede cambiarlo en Google.
ALTER TABLE users ADD COLUMN google_sub VARCHAR(64) NULL;
ALTER TABLE users ADD UNIQUE KEY uniq_google_sub (google_sub);

-- Quien entra solo con Google no tiene contrasena que guardar.
ALTER TABLE users MODIFY password_hash VARCHAR(255) NULL;
