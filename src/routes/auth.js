// Registro, login, revalidacion de sesion y disponibilidad de nombre.
function registerAuthRoutes(app, { getDbPool, bcrypt, signSession, verifySession, isNameRegistered, loginFailLimiter, LOGIN_FAIL_LIMIT }) {
    app.post('/api/register', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });
        }
        if (username.length < 2 || username.length > 20) {
            return res.status(400).json({ error: 'El nombre debe tener entre 2 y 20 caracteres.' });
        }
        if (password.length < 4) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
        }
        if (!/^[a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ_]+$/.test(username)) {
            return res.status(400).json({ error: 'El nombre solo puede contener letras, números y guiones bajos.' });
        }

        const dbPool = getDbPool();
        try {
            const [existing] = await dbPool.query('SELECT id FROM users WHERE username = ?', [username]);
            if (existing.length > 0) {
                return res.status(409).json({ error: 'Ese nombre de usuario ya está registrado.' });
            }

            const hash = await bcrypt.hash(password, 10);
            const [result] = await dbPool.query('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
            await dbPool.query('INSERT INTO user_stats (user_id) VALUES (?)', [result.insertId]);

            res.status(201).json({
                message: 'Registro exitoso.',
                username,
                token: signSession(result.insertId, 0)
            });
        } catch (error) {
            console.error("Register error:", error);
            res.status(500).json({ error: 'Error del servidor.' });
        }
    });

    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });
        }

        // Bloqueo por fuerza bruta: independiente del limite general de /api/,
        // solo cuenta fallos y se resetea solo (la ventana caduca) o al acertar.
        if (loginFailLimiter.count(req.ip) >= LOGIN_FAIL_LIMIT) {
            return res.status(429).json({ error: 'Demasiados intentos fallidos. Prueba de nuevo en unos minutos.' });
        }

        const dbPool = getDbPool();
        try {
            const [rows] = await dbPool.query('SELECT id, username, password_hash, token_version FROM users WHERE username = ?', [username]);
            if (rows.length === 0) {
                loginFailLimiter.hit(req.ip);
                return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
            }

            const user = rows[0];
            const valid = await bcrypt.compare(password, user.password_hash);
            if (!valid) {
                loginFailLimiter.hit(req.ip);
                return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
            }

            loginFailLimiter.reset(req.ip);
            res.json({
                message: 'Login exitoso.',
                username: user.username,
                token: signSession(user.id, user.token_version)
            });
        } catch (error) {
            console.error("Login error:", error);
            res.status(500).json({ error: 'Error del servidor.' });
        }
    });

    // Revalida el token que el cliente tiene guardado al arrancar
    app.post('/api/session', async (req, res) => {
        const session = await verifySession(req.body?.token);
        if (!session) return res.status(401).json({ error: 'Sesión no válida o caducada.' });
        res.json({ username: session.username });
    });

    // Los nombres de cuentas registradas estan reservados para invitados.
    // Se consulta al entrar como invitado, para avisar en el momento oportuno.
    app.get('/api/name-available/:name', async (req, res) => {
        const name = String(req.params.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Nombre requerido.' });
        res.json({ available: !(await isNameRegistered(name)) });
    });
}

module.exports = { registerAuthRoutes };
