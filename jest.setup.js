// Carga el diccionario real desde la BD (igual que hace server.js al arrancar)
// para que las funciones de palabras se prueben contra datos reales.
// Para correr desde el host: DB_HOST=127.0.0.1 (mariadb esta publicado en 3306)
const mysql = require('mysql2/promise');
const { normalizeForMatch } = require('./lib/game-logic');

let pool;

beforeAll(async () => {
  const config = require('./config');
  pool = await mysql.createPool({
    host: process.env.DB_HOST || config.host,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 2
  });
  const [rows] = await pool.query('SELECT word FROM words');
  const dict = new Set();
  for (const row of rows) dict.add(normalizeForMatch(row.word));
  globalThis.__WORD_DICT__ = dict;
  // eslint-disable-next-line no-console
  console.log(`[jest] Diccionario cargado: ${dict.size} palabras`);
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
});