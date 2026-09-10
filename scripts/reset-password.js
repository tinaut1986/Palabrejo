#!/usr/bin/env node
// Restablece la contrasena de un usuario desde el servidor.
//
//   docker exec -it palabrero_server node scripts/reset-password.js <usuario>
//   docker exec -it palabrero_server node scripts/reset-password.js <usuario> --random
//   docker exec -it palabrero_server node scripts/reset-password.js --list
//
// Al cambiar la contrasena se incrementa users.token_version, de modo que todas
// las sesiones abiertas de ese usuario quedan invalidadas: quien estuviera
// dentro con un token antiguo deja de estarlo.

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const readline = require('readline');
const path = require('path');
const dbConfig = require(path.join(__dirname, '..', 'config'));

const MIN_LENGTH = 4;

// Lee por teclado sin dejar rastro de lo escrito en pantalla
function askHidden(question) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY) {
            return reject(new Error('No hay terminal interactiva. Usa --random, o ejecuta con "docker exec -it".'));
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const onData = () => {
            // Repinta la linea con solo la pregunta, ocultando lo tecleado
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(question);
        };
        process.stdin.on('data', onData);
        rl.question(question, (answer) => {
            process.stdin.removeListener('data', onData);
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}

// 12 caracteres legibles, sin los que se confunden al dictarlos (l/1/O/0)
function randomPassword() {
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(crypto.randomBytes(12))
        .map(b => alphabet[b % alphabet.length])
        .join('');
}

async function main() {
    const args = process.argv.slice(2);
    const random = args.includes('--random');
    const list = args.includes('--list');
    const username = args.find(a => !a.startsWith('--'));

    if (!list && !username) {
        console.error('Uso: node scripts/reset-password.js <usuario> [--random]');
        console.error('     node scripts/reset-password.js --list');
        process.exit(1);
    }

    const db = await mysql.createConnection(dbConfig);
    try {
        if (list) {
            const [rows] = await db.query('SELECT username, created_at FROM users ORDER BY username');
            if (rows.length === 0) {
                console.log('No hay usuarios registrados.');
                return;
            }
            console.log(`${rows.length} usuario(s):`);
            for (const r of rows) {
                console.log(`  ${r.username}  (desde ${new Date(r.created_at).toLocaleDateString('es-ES')})`);
            }
            return;
        }

        const [users] = await db.query('SELECT id, username FROM users WHERE username = ?', [username]);
        if (users.length === 0) {
            console.error(`No existe el usuario "${username}". Puedes listarlos con --list.`);
            process.exit(2);
        }
        const user = users[0];

        let password;
        if (random) {
            password = randomPassword();
        } else {
            password = await askHidden(`Nueva contrasena para "${user.username}": `);
            const repeat = await askHidden('Repitela: ');
            if (password !== repeat) {
                console.error('Las contrasenas no coinciden.');
                process.exit(3);
            }
        }

        if (password.length < MIN_LENGTH) {
            console.error(`La contrasena debe tener al menos ${MIN_LENGTH} caracteres.`);
            process.exit(4);
        }

        const hash = await bcrypt.hash(password, 10);
        await db.query(
            'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
            [hash, user.id]
        );

        console.log(`\nContrasena de "${user.username}" actualizada.`);
        if (random) console.log(`Nueva contrasena: ${password}`);
        console.log('Sus sesiones abiertas han quedado invalidadas.');
    } finally {
        await db.end();
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
