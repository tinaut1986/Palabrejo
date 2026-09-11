-- Palabrejo: vincular la cuenta con Microsoft (Outlook / Hotmail)

-- Mismo planteamiento que con Google: se guarda el identificador estable que
-- da el proveedor, porque el correo puede cambiar y no sirve como identidad.
ALTER TABLE users ADD COLUMN microsoft_sub VARCHAR(64) NULL;
ALTER TABLE users ADD UNIQUE KEY uniq_microsoft_sub (microsoft_sub);
