document.addEventListener('DOMContentLoaded', async () => {
    // --- STATE ---
    let socket = null;
    let currentUser = null; // { username, token } o null si se juega como invitado
    let guestName = '';     // nombre en uso cuando se juega como invitado
    let currentRoom = null;
    let isHost = false;
    let resumeToken = null;
    let roundTimer = null;
    let timeLeft = 0;
    let nextTimer = null;
    let restTimer = null;
    let roundScore = 0; // puntos de la ronda en curso (mío)
    let lastQrUrl = null; // ultimo QR pintado, para no regenerarlo sin motivo
    let pendingRoom = false; // esperando que el servidor confirme sala creada/unida

    // --- ELEMENTS ---
    const $ = id => document.getElementById(id);
    const views = ['setup-view', 'lobby-view', 'room-browser-view', 'waiting-room-view', 'game-view', 'round-results-view', 'game-over-view', 'profile-view', 'friends-view'];

    function showView(viewId) {
        views.forEach(v => $(v).classList.remove('active'));
        $(viewId).classList.add('active');
    }

    // Entrar en una sala es una ida y vuelta con el servidor: hasta que
    // confirma no se cambia de vista, para no plantar al jugador en una sala
    // en espera vacia si la peticion se rechaza.
    function setPendingRoom(pending) {
        pendingRoom = pending;
        $('create-room-btn').disabled = pending;
        $('join-room-btn').disabled = pending;
    }

    function showError(elementId, msg) {
        $(elementId).textContent = msg;
        setTimeout(() => { $(elementId).textContent = ''; }, 4000);
    }

    // --- QR CODE GENERATOR (minimal) ---
    function generateQR(text, canvas, size = 150) {
        const ctx = canvas.getContext('2d');
        canvas.width = size;
        canvas.height = size;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000000';

        // Simple QR-like visual placeholder (real QR would need a library)
        // We'll encode the URL as a visual pattern
        const url = text;
        const moduleCount = 21;
        const cellSize = size / moduleCount;

        // Use a deterministic pattern based on the URL
        const data = [];
        for (let i = 0; i < moduleCount * moduleCount; i++) {
            const charCode = url.charCodeAt(i % url.length) || 0;
            data.push((charCode + i * 7) % 3 === 0);
        }

        // Finder patterns
        const drawFinder = (x, y) => {
            for (let dy = 0; dy < 7; dy++) {
                for (let dx = 0; dx < 7; dx++) {
                    const isEdge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
                    const isInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
                    if (isEdge || isInner) {
                        ctx.fillRect((x + dx) * cellSize, (y + dy) * cellSize, cellSize, cellSize);
                    }
                }
            }
        };

        drawFinder(0, 0);
        drawFinder(moduleCount - 7, 0);
        drawFinder(0, moduleCount - 7);

        // Fill data area
        for (let y = 0; y < moduleCount; y++) {
            for (let x = 0; x < moduleCount; x++) {
                const inFinder = (x < 8 && y < 8) || (x >= moduleCount - 8 && y < 8) || (x < 8 && y >= moduleCount - 8);
                if (!inFinder && data[y * moduleCount + x]) {
                    ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
                }
            }
        }
    }

    // For a proper QR code, let's use a simple API fallback
    function generateQRCode(text, canvas) {
        const size = 150;
        const ctx = canvas.getContext('2d');
        canvas.width = size;
        canvas.height = size;

        // Use a QR code API for proper rendering
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            ctx.drawImage(img, 0, 0, size, size);
        };
        img.onerror = () => {
            // Fallback: just show the text
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = '#000000';
            ctx.font = '12px Inter';
            ctx.textAlign = 'center';
            ctx.fillText(text, size / 2, size / 2);
        };
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
    }

    // --- RESUME STORAGE ---
    // Survives a page reload so a player can get back into an in-progress game.
    function saveResume(roomCode, token) {
        try { sessionStorage.setItem('palabrejoResume', JSON.stringify({ code: roomCode, token })); } catch (e) {}
    }
    function readResume() {
        try { return JSON.parse(sessionStorage.getItem('palabrejoResume') || 'null'); } catch (e) { return null; }
    }
    function clearResume() {
        try { sessionStorage.removeItem('palabrejoResume'); } catch (e) {}
    }

    // --- IDENTIDAD PERSISTENTE ---
    // Recuerda con quien se jugo la ultima vez (registrado o invitado) para no
    // tener que volver a presentarse. En localStorage, asi que sobrevive a
    // cerrar el navegador, al contrario que el token de reanudacion de partida.
    const IDENTITY_KEY = 'palabrejoIdentity';

    function saveIdentity() {
        try {
            const identity = currentUser
                ? { type: 'user', username: currentUser.username, token: currentUser.token }
                : { type: 'guest', name: guestName };
            localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
        } catch (e) {}
    }

    function readIdentity() {
        try {
            const raw = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
            if (!raw) return null;
            if (raw.type === 'user' && raw.username && raw.token) return raw;
            if (raw.type === 'guest' && raw.name) return raw;
            return null;
        } catch (e) { return null; }
    }

    function clearIdentity() {
        try { localStorage.removeItem(IDENTITY_KEY); } catch (e) {}
    }

    // Nombre con el que entrar a las salas
    function playerDisplayName() {
        return currentUser ? currentUser.username : guestName;
    }

    function updateUserBadge() {
        const badge = $('user-badge');
        badge.textContent = currentUser
            ? `🎮 ${currentUser.username}`
            : `👤 ${guestName} (invitado)`;
        // Un invitado no tiene perfil ni amigos: el badge no es pulsable
        badge.classList.toggle('plain', !currentUser);
        badge.title = currentUser ? 'Ver mi perfil' : '';
        $('view-friends-btn').classList.toggle('hidden', !currentUser);
        if (currentUser) refreshFriendsBadge();
    }

    // Entra al hall con la identidad ya fijada
    function enterLobby() {
        saveIdentity();
        updateUserBadge();
        if (!socket) connectSocket();
        showView('lobby-view');
    }

    // Al arrancar: si ya sabemos quien juega, directo al hall. La sesion de un
    // usuario registrado se revalida contra el servidor, que es quien dice si
    // el token sigue siendo bueno.
    async function restoreIdentity() {
        const identity = readIdentity();
        if (!identity) return false;

        if (identity.type === 'guest') {
            // El nombre pudo registrarse como cuenta despues de guardarse aqui
            try {
                const res = await fetch(`/api/name-available/${encodeURIComponent(identity.name)}`);
                if ((await res.json()).available === false) {
                    clearIdentity();
                    $('player-name-input').value = identity.name;
                    showError('setup-error', `"${identity.name}" ya es una cuenta registrada. Inicia sesión o usa otro nombre.`);
                    return false;
                }
            } catch (e) { /* sin red, se deja pasar: el servidor avisara */ }

            currentUser = null;
            guestName = identity.name;
            $('player-name-input').value = identity.name;
            enterLobby();
            return true;
        }

        try {
            const res = await fetch('/api/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: identity.token })
            });
            if (!res.ok) throw new Error('Sesión caducada');
            const data = await res.json();
            currentUser = { username: data.username, token: identity.token };
            guestName = '';
            enterLobby();
            return true;
        } catch (e) {
            // Token caducado o revocado: a presentarse de nuevo
            clearIdentity();
            return false;
        }
    }

    // --- SOCKET CONNECTION ---
    function connectSocket() {
        socket = io();

        socket.on('connect', () => {
            console.log('Connected to server');
            const stored = readResume();
            if (resumeToken && currentRoom) {
                // Live reconnection after a drop: get back into the game
                socket.emit('rejoinGame', { roomCode: currentRoom.code, token: resumeToken });
            } else if (stored && !currentRoom) {
                // Reload mid-game
                socket.emit('rejoinGame', { roomCode: stored.code, token: stored.token });
            }
        });

        socket.on('disconnect', () => {
            if (resumeToken) showFeedback('Reconectando…', 'invalid');
        });

        socket.on('playerToken', ({ roomCode, token }) => {
            resumeToken = token;
            saveResume(roomCode, token);
        });

        socket.on('error', (msg) => {
            showError('lobby-error', msg);
            showError('setup-error', msg);
            // Cualquier error de sala deja el contexto de partida inservible.
            // Se limpia siempre, tambien cuando el estado local ya esta vacio:
            // justo tras recargar quedaba un token de reanudacion caducado.
            clearResume();
            resumeToken = null;
            // Si esperabamos entrar en una sala, la entrada se ha ido al garete
            if (pendingRoom || currentRoom) {
                setPendingRoom(false);
                currentRoom = null;
                stopTimer();
                stopNextTimer();
                showView('lobby-view');
            }
        });

        // La sesion guardada ya no vale: olvidarla y volver a la pantalla de acceso
        socket.on('sessionExpired', (msg) => {
            clearIdentity();
            currentUser = null;
            guestName = '';
            currentRoom = null;
            resumeToken = null;
            clearResume();
            stopTimer();
            stopNextTimer();
            showView('setup-view');
            showError('setup-error', msg);
        });

        socket.on('roomStateUpdate', (state) => {
            const isRejoin = !currentRoom;
            const wasPending = pendingRoom;
            setPendingRoom(false);
            currentRoom = state;
            isHost = state.players.find(p => p.id === socket.id)?.isHost;
            // Solo refrescamos la sala de espera si es donde estamos: en juego
            // este evento llega con cada palabra acertada y regenerar el QR
            // dispararia una peticion externa por palabra.
            if (state.gameState === 'waiting') {
                updateWaitingRoom(state);
                // La sala solo se muestra con datos ya en mano: al confirmarse
                // la entrada, o al volver a ella tras un F5
                if (wasPending || isRejoin) showView('waiting-room-view');
            }
            updateScores();
        });

        socket.on('roundStart', (data) => {
            stopNextTimer();
            stopRestTimer();
            showView('game-view');
            // El total de rondas viene en el evento: al reanudar tras un F5
            // puede que aún no tengamos el estado de la sala.
            const totalRounds = data.totalRounds || currentRoom?.totalRounds || '?';
            $('round-display').textContent = `Ronda ${data.round}/${totalRounds}`;

            rackLetters = data.letters.map(l => canonicalLetter(l));
            builtWord = [];
            $('letters-display').innerHTML = data.letters
                .map(l => `<button type="button" class="letter-tile" data-letter="${l}">${l}</button>`)
                .join('');
            renderBuiltWord();

            // Al reanudar, el servidor devuelve las palabras ya acertadas
            myWords = (data.words || []).map(w => ({
                key: canonicalLetter(w.word),
                word: w.word,
                type: 'valid',
                points: w.points
            }));
            renderMyWords();
            roundScore = myWords.reduce((sum, w) => sum + (w.points || 0), 0);
            updateScorePills();

            timeLeft = data.time;
            startTimer();
        });

        socket.on('wordResult', (data) => {
            if (data.valid) {
                addWordChip(data.word, 'valid', data.points);
                showFeedback(`${data.word.toUpperCase()} +${data.points}`, 'valid');
                roundScore += data.points;
                updateScorePills();
                flashElement($('built-word'), 'flash-ok');
                vibrate(15);
            } else {
                addWordChip(data.word, data.reason === 'duplicate' ? 'duplicate' : 'invalid');
                const msgs = {
                    duplicate: 'Ya usaste esa palabra',
                    used_by_other: 'Otro jugador ya la usó',
                    invalid: 'Palabra no válida'
                };
                showFeedback(msgs[data.reason] || 'No válida', 'invalid');
                shakeElement($('built-word'));
                vibrate([15, 40, 15]);
            }
            // After trying a word the builder clears for the next one
            clearBuilt();
        });

        socket.on('roundEnd', (data) => {
            stopTimer();
            showRoundResults(data);
        });

        socket.on('gameOver', (data) => {
            stopTimer();
            stopNextTimer();
            // La partida ha terminado: salir ya no pide confirmacion
            if (currentRoom) currentRoom.gameState = 'rest';
            showGameOver(data);
        });

        // Tras el fin de la partida hay un descanso y arranca otra nueva con
        // los mismos jugadores. El servidor lo confirma con esta cuenta atras.
        socket.on('restStart', (data) => {
            stopNextTimer();
            showView('game-over-view');
            startRestCountdown(data.delay);
        });

        socket.on('publicRoomsList', (rooms) => {
            updateRoomsList(rooms);
        });
    }

    // --- TIMER ---
    function startTimer() {
        stopTimer();
        updateTimerDisplay();
        roundTimer = setInterval(() => {
            timeLeft--;
            updateTimerDisplay();
            if (timeLeft <= 0) {
                stopTimer();
                // Ask the server to wrap up the round (safe: it only honours
                // this in the final seconds, and ignores it if already ended).
                if (socket) socket.emit('roundTimeout');
            }
        }, 1000);
    }

    function stopTimer() {
        if (roundTimer) {
            clearInterval(roundTimer);
            roundTimer = null;
        }
    }

    function startNextCountdown() {
        stopNextTimer();
        let s = 5;
        const el = $('round-results-next');
        if (el) el.textContent = `Siguiente ronda en ${s} s...`;
        nextTimer = setInterval(() => {
            s--;
            if (s <= 0) {
                stopNextTimer();
                if (el) el.textContent = 'Esperando a los demás...';
            } else {
                if (el) el.textContent = `Siguiente ronda en ${s} s...`;
            }
        }, 1000);
    }

    function stopNextTimer() {
        if (nextTimer) {
            clearInterval(nextTimer);
            nextTimer = null;
        }
    }

    // Cuenta atras del descanso entre partidas: muestra en la pantalla de fin
    // el tiempo que falta para que arranque la siguiente partida.
    function startRestCountdown(delayMs) {
        stopRestTimer();
        const el = $('game-over-next');
        if (!el) return;
        let s = Math.max(1, Math.ceil(delayMs / 1000));
        el.innerHTML = `Nueva partida en <span class="rest-countdown-num">${s}s</span>`;
        restTimer = setInterval(() => {
            s--;
            if (s <= 0) {
                stopRestTimer();
                el.innerHTML = `Nueva partida en <span class="rest-countdown-num">0s</span>`;
            } else {
                el.innerHTML = `Nueva partida en <span class="rest-countdown-num">${s}s</span>`;
            }
        }, 1000);
    }

    function stopRestTimer() {
        if (restTimer) {
            clearInterval(restTimer);
            restTimer = null;
        }
    }

    function updateTimerDisplay() {
        const el = $('timer-display');
        el.textContent = `${timeLeft}s`;
        el.className = 'timer';
        if (timeLeft <= 10) el.classList.add('danger');
        else if (timeLeft <= 30) el.classList.add('warning');
    }

    // --- WORD INPUT ---
    // Las palabras se guardan en una lista y se pintan siempre en orden
    // alfabético (por su forma canónica, así "á" ordena junto a "a").
    // Reintentar una palabra actualiza su entrada en lugar de duplicarla.
    let myWords = [];

    function addWordChip(word, type, points = 0) {
        const key = canonicalLetter(word);
        const existing = myWords.find(w => w.key === key);
        if (existing) {
            existing.word = word;
            existing.type = type;
            existing.points = points;
        } else {
            myWords.push({ key, word, type, points });
        }
        renderMyWords(key);
    }

    function renderMyWords(highlightKey = null) {
        const sorted = [...myWords].sort((a, b) => a.key.localeCompare(b.key, 'es'));
        $('my-words-list').innerHTML = sorted.map(w => `
            <span class="word-chip ${w.type}${w.key === highlightKey ? ' just-added' : ''}" data-key="${w.key}">${w.word}${w.type === 'valid' && w.points ? `<small>+${w.points}</small>` : ''}</span>
        `).join('');
        const validCount = myWords.filter(w => w.type === 'valid').length;
        const countEl = $('my-words-count');
        if (countEl) countEl.textContent = validCount;
    }

    function showFeedback(msg, type) {
        const el = $('word-feedback');
        el.textContent = msg;
        el.className = `feedback ${type}`;
        setTimeout(() => { el.className = 'feedback hidden'; }, 2000);
    }

    function flashElement(el, cls) {
        if (!el) return;
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
        setTimeout(() => el.classList.remove(cls), 500);
    }

    // Vibración corta en móvil como refuerzo táctil (se ignora sin soporte)
    function vibrate(pattern) {
        try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
    }

    function shakeElement(el) {
        if (!el) return;
        el.classList.remove('shake');
        void el.offsetWidth;
        el.classList.add('shake');
        setTimeout(() => el.classList.remove('shake'), 450);
    }

    // --- WORD BUILDER ---
    let builtWord = [];
    let rackLetters = [];

    // En móvil no hay teclado físico: el texto de ayuda se adapta
    const BUILDER_HINT = window.matchMedia('(hover: hover) and (pointer: fine)').matches
        ? 'Pulsa las letras o escribe con el teclado'
        : 'Pulsa las letras para formar tu palabra';

    // Feedback de pulsación: hunde la tecla y lanza una letra "fantasma"
    // desde ella hasta la palabra en construcción.
    function animateTilePress(tile) {
        if (!tile) return;
        tile.classList.remove('pressed');
        void tile.offsetWidth;
        tile.classList.add('pressed');
        setTimeout(() => tile.classList.remove('pressed'), 300);
        flyLetterToWord(tile);
    }

    function flyLetterToWord(tile) {
        const target = $('built-word');
        if (!target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const from = tile.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        const ghost = document.createElement('div');
        ghost.className = 'letter-ghost';
        ghost.textContent = tile.dataset.letter || tile.textContent;
        ghost.style.left = `${from.left}px`;
        ghost.style.top = `${from.top}px`;
        ghost.style.width = `${from.width}px`;
        ghost.style.height = `${from.height}px`;
        document.body.appendChild(ghost);
        const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
        const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
        ghost.animate([
            { transform: 'translate(0,0) scale(1)', opacity: 0.95 },
            { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) scale(0.8)`, opacity: 0.7 },
            { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 }
        ], { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)' }).onfinish = () => ghost.remove();
    }

    // Localiza la tecla del rack correspondiente a una letra escrita a teclado
    function findTile(letter) {
        const cl = canonicalLetter(letter);
        return [...document.querySelectorAll('#letters-display .letter-tile')]
            .find(t => canonicalLetter(t.dataset.letter) === cl);
    }

    function canonicalLetter(c) {
        return c.normalize('NFD')
            .replace(/n\u0303/gi, 'ñ')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
    }

    function renderBuiltWord(animateLast = false) {
        const el = $('built-word');
        if (builtWord.length === 0) {
            el.innerHTML = `<span class="placeholder">${BUILDER_HINT}</span>`;
            return;
        }
        const last = builtWord.length - 1;
        el.innerHTML = builtWord
            .map((l, i) => `<span class="built-letter${animateLast && i === last ? ' new' : ''}">${l}</span>`)
            .join('');
    }

    function addBuiltLetter(letter) {
        builtWord.push(letter);
        renderBuiltWord(true);
    }

    function backspaceBuilt() {
        if (builtWord.length === 0) return;
        builtWord.pop();
        renderBuiltWord();
        vibrate(8);
    }

    function clearBuilt() {
        builtWord = [];
        renderBuiltWord();
    }

    function submitBuild() {
        const word = builtWord.join('').toLowerCase();
        if (word.length < 3) {
            showFeedback('Mínimo 3 letras', 'invalid');
            return;
        }
        socket.emit('submitWord', { word });
    }

    function handleKeyboardKey(e) {
        // Con el dialogo abierto, Escape cancela y el resto no llega al juego
        if (isConfirmOpen()) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeConfirm(false);
            }
            return;
        }
        if (!$('game-view').classList.contains('active')) return;
        const key = e.key;
        if (key === 'Backspace') {
            e.preventDefault();
            backspaceBuilt();
            return;
        }
        if (key === 'Enter') {
            e.preventDefault();
            submitBuild();
            return;
        }
        if (key === 'Escape') {
            e.preventDefault();
            clearBuilt();
            return;
        }
        // Any other single character (incl. accented, e.g. "á") whose canonical
        // form is a rack letter builds the word.
        if (key.length === 1) {
            const cl = canonicalLetter(key);
            if (cl.length === 1 && /[a-zñ]/i.test(cl)) {
                if (rackLetters.includes(cl)) {
                    addBuiltLetter(key.toUpperCase());
                    animateTilePress(findTile(key));
                } else {
                    showFeedback('Esa letra no está en el tablero', 'invalid');
                }
                e.preventDefault();
            }
        }
    }

    // --- WAITING ROOM ---
    function updateWaitingRoom(state) {
        $('room-code-display').textContent = state.code;

        // Solo play hint
        const soloHint = document.getElementById('solo-hint');
        if (soloHint) soloHint.style.display = state.players.length < 2 ? 'block' : 'none';

        // QR: se regenera solo si cambia la sala (evita una peticion externa
        // por cada actualizacion de estado)
        const joinUrl = `${window.location.origin}?join=${state.code}`;
        if (lastQrUrl !== joinUrl) {
            lastQrUrl = joinUrl;
            generateQRCode(joinUrl, $('qr-canvas'));
        }

        // Players
        const playersHtml = state.players.map(p => `
            <div class="player-item">
                <span class="player-name">${p.name}</span>
                ${p.isHost ? '<span class="player-host">HOST</span>' : ''}
            </div>
        `).join('');
        $('waiting-players').innerHTML = playersHtml;

        // Host controls
        if (isHost) {
            $('host-controls').classList.remove('hidden');
        } else {
            $('host-controls').classList.add('hidden');
        }
    }

    function updateRoomsList(rooms) {
        const list = $('public-rooms-list');
        if (rooms.length === 0) {
            list.innerHTML = '<p class="empty-state">No hay salas públicas disponibles.</p>';
            return;
        }
        list.innerHTML = rooms.map(r => `
            <div class="room-item" data-code="${r.code}">
                <div class="room-info">
                    <span class="room-code-label">${r.code}</span>
                    <span class="room-players">${r.playerCount}/${r.maxPlayers} jugadores</span>
                </div>
                <button class="btn-secondary btn-sm" onclick="joinRoom('${r.code}')">Unirse</button>
            </div>
        `).join('');
    }

    // --- ROUND RESULTS ---
    function showRoundResults(data) {
        showView('round-results-view');
        $('round-results-title').textContent = `Resultados - Ronda ${data.round}`;

        const sorted = [...data.results].sort((a, b) => b.totalScore - a.totalScore);
        $('round-results-body').innerHTML = sorted.map((p, i) => {
            const isMe = p.id === socket.id;
            return `
                <div class="result-player">
                    <span class="result-name ${isMe ? 'score-you' : ''}">
                        ${i === 0 ? '👑 ' : ''}${p.name}
                    </span>
                    <span class="result-score">${p.totalScore} pts <small class="result-round">(+${p.scoreThisRound || 0} esta ronda)</small></span>
                    <div class="result-words">
                        ${p.wordsThisRound.length > 0
                            ? p.wordsThisRound.map(w => `<span class="word-chip valid" style="display:inline-block;margin:2px;font-size:0.75rem;">${w}</span>`).join('')
                            : '<em>No formó palabras</em>'}
                    </div>
                </div>
            `;
        }).join('');
        startNextCountdown();
    }

    // --- GAME OVER ---
    function showGameOver(data) {
        showView('game-over-view');
        $('game-over-title').textContent = `🏆 ${data.winner.name} gana!`;

        $('game-over-body').innerHTML = data.players.map((p, i) => `
            <div class="result-player">
                <span class="result-name">
                    ${i === 0 ? '👑 ' : ''}${p.name}
                    ${i === 0 ? '<span class="winner-badge">CAMPEÓN</span>' : ''}
                </span>
                <span class="result-score">${p.score} pts</span>
                <div class="result-words">
                    ${p.wordsFound.map(w => `<span class="word-chip valid" style="display:inline-block;margin:2px;font-size:0.75rem;">${w}</span>`).join('')}
                </div>
            </div>
        `).join('');
    }

    // --- SCORES UPDATE ---
    // Pinta el marcador (total + puntos de la ronda en curso) y las píldoras
    // de cabecera con mi ronda, mi total y mi puesto.
    function updateScores() {
        if (!currentRoom) return;
        const players = [...currentRoom.players].sort((a, b) => b.score - a.score);
        const maxScore = Math.max(...players.map(p => p.score), 1);

        $('scores-list').innerHTML = players.map(p => {
            const isMe = p.id === socket.id;
            const pct = (p.score / maxScore) * 100;
            const leading = p.score === maxScore && maxScore > 0;
            const rs = p.roundScore || 0;
            return `
                <div class="score-row">
                    <span class="score-name ${isMe ? 'score-you' : ''}">${p.name}</span>
                    <div class="score-bar-container">
                        <div class="score-bar ${leading ? 'leading' : ''}" style="width: ${pct}%"></div>
                    </div>
                    <span class="score-round ${rs ? '' : 'zero'}">+${rs}</span>
                    <span class="score-value">${p.score}</span>
                </div>
            `;
        }).join('');

        const me = players.find(p => p.id === socket.id);
        if (me) {
            roundScore = me.roundScore || 0;
            myTotalScore = me.score || 0;
            myRank = `${players.indexOf(me) + 1}/${players.length}`;
        }
        updateScorePills();
    }

    let myTotalScore = 0;
    let myRank = '-';

    function updateScorePills() {
        setPill('round-score', roundScore);
        setPill('total-score', myTotalScore);
        const rank = $('rank-display');
        if (rank) rank.textContent = myRank;
    }

    // Al cambiar, el número da un pequeño salto para que se note
    function setPill(id, value) {
        const el = $(id);
        if (!el) return;
        const next = String(value);
        if (el.textContent === next) return;
        el.textContent = next;
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
    }

    // --- PROFILE ---
    let profileReturnView = 'lobby-view';
    let profileUsername = null;

    function openProfile(username, returnView = 'lobby-view') {
        profileReturnView = returnView;
        loadProfile(username);
        showView('profile-view');
    }

    async function loadProfile(username) {
        profileUsername = username;
        const isMe = currentUser && username === currentUser.username;
        $('profile-title').textContent = isMe ? 'Mi perfil' : username;
        $('profile-friend-action').innerHTML = '';
        try {
            const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
            if (!res.ok) throw new Error('No encontrado');
            const data = await res.json();
            if (!isMe) renderProfileFriendAction(username);

            $('profile-body').innerHTML = `
                <h3>${data.username}</h3>
                <p style="color:var(--text-dim);font-size:0.85rem;">Miembro desde ${new Date(data.created_at).toLocaleDateString('es-ES')}</p>
                <div class="stat-grid">
                    <div class="stat-card">
                        <div class="stat-value">${data.games_played}</div>
                        <div class="stat-label">Partidas</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${data.games_won}</div>
                        <div class="stat-label">Victorias</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${data.total_words}</div>
                        <div class="stat-label">Palabras</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${data.best_score}</div>
                        <div class="stat-label">Mejor puntuación</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${data.avg_score}</div>
                        <div class="stat-label">Media/partida</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${data.total_score}</div>
                        <div class="stat-label">Puntos totales</div>
                    </div>
                </div>
            `;
        } catch (e) {
            $('profile-body').innerHTML = '<p class="empty-state">No se pudo cargar el perfil.</p>';
        }
    }

    // --- AMIGOS ---
    let friendsData = { me: null, friends: [], incoming: [], outgoing: [] };
    let compareMetric = 'total_score';

    const METRIC_LABELS = {
        total_score: 'puntos',
        games_won: 'victorias',
        best_score: 'mejor partida',
        avg_score: 'media por partida'
    };

    function authHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentUser?.token || ''}`
        };
    }

    async function fetchFriends() {
        const res = await fetch('/api/friends', { headers: authHeaders() });
        if (!res.ok) throw new Error('No se pudo cargar la lista de amigos.');
        return res.json();
    }

    // Solo el contador del hall, sin pintar la vista entera
    async function refreshFriendsBadge() {
        if (!currentUser) return;
        try {
            friendsData = await fetchFriends();
            const badge = $('friends-badge');
            const n = friendsData.incoming.length;
            badge.textContent = n;
            badge.classList.toggle('hidden', n === 0);
        } catch (e) { /* sin conexion: el contador puede esperar */ }
    }

    async function loadFriends() {
        try {
            friendsData = await fetchFriends();
            renderFriends();
            return true;
        } catch (e) {
            showError('friends-error', e.message);
        }
    }

    async function friendAction(path, username) {
        try {
            const res = await fetch(`/api/friends/${path}`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ username })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'No se pudo completar la acción.');
            await loadFriends();
            // El boton de amistad del perfil tambien queda desfasado
            if ($('profile-view').classList.contains('active') && profileUsername) {
                renderProfileFriendAction(profileUsername);
            }
            return true;
        } catch (e) {
            const target = $('profile-view').classList.contains('active')
                ? 'profile-error' : 'friends-error';
            showError(target, e.message);
            return false;
        }
    }

    function friendRow(username, actions) {
        return `
            <div class="friend-row">
                <button type="button" class="friend-name" data-user="${username}">${username}</button>
                ${actions}
            </div>
        `;
    }

    function renderFriends() {
        const { friends, incoming, outgoing } = friendsData;

        $('friend-requests').classList.toggle('hidden', incoming.length === 0);
        $('friend-requests-list').innerHTML = incoming.map(u => friendRow(u, `
            <button type="button" class="friend-action accept" data-accept="${u}">Aceptar</button>
            <button type="button" class="friend-action danger" data-remove="${u}">Rechazar</button>
        `)).join('');

        $('friends-pending').classList.toggle('hidden', outgoing.length === 0);
        $('friends-pending-list').innerHTML = outgoing.map(u => friendRow(u, `
            <button type="button" class="friend-action" data-remove="${u}">Cancelar</button>
        `)).join('');

        const badge = $('friends-badge');
        badge.textContent = incoming.length;
        badge.classList.toggle('hidden', incoming.length === 0);

        renderCompare();
    }

    // Comparativa: yo y mis amigos, ordenados por la metrica elegida
    function renderCompare() {
        const box = $('friends-compare');
        const me = friendsData.me;
        if (!me) { box.innerHTML = ''; return; }

        if (friendsData.friends.length === 0) {
            box.innerHTML = `<p class="empty-state">Añade amigos para comparar vuestras ${METRIC_LABELS[compareMetric]}.</p>`;
            return;
        }

        const rows = [{ ...me, isMe: true }, ...friendsData.friends]
            .sort((a, b) => b[compareMetric] - a[compareMetric]);
        const max = Math.max(...rows.map(r => r[compareMetric]), 1);
        const medals = ['🥇', '🥈', '🥉'];

        box.innerHTML = rows.map((r, i) => `
            <div class="compare-row ${r.isMe ? 'is-me' : ''}">
                <span class="compare-rank">${medals[i] || i + 1}</span>
                <span class="compare-name">${r.username}</span>
                <div class="compare-bar-container">
                    <div class="compare-bar" style="width:${(r[compareMetric] / max) * 100}%"></div>
                </div>
                <span class="compare-value">${r[compareMetric]}</span>
            </div>
        `).join('');
    }

    // Boton de amistad dentro del perfil de otro jugador
    function renderProfileFriendAction(username) {
        const box = $('profile-friend-action');
        if (!currentUser) { box.innerHTML = ''; return; }

        if (friendsData.friends.some(f => f.username === username)) {
            box.innerHTML = `<button type="button" class="friend-action danger" data-remove="${username}">Eliminar de amigos</button>`;
        } else if (friendsData.outgoing.includes(username)) {
            box.innerHTML = `<button type="button" class="friend-action" data-remove="${username}">Cancelar solicitud</button>`;
        } else if (friendsData.incoming.includes(username)) {
            box.innerHTML = `<button type="button" class="friend-action accept" data-accept="${username}">Aceptar solicitud</button>`;
        } else {
            box.innerHTML = `<button type="button" class="friend-action accept" data-request="${username}">Añadir a amigos</button>`;
        }
    }

    // --- ROOM CONFIG ---
    const configDefaults = { 'max-players': 8, 'total-rounds': 5, 'round-time': 90 };
    const configLimits = {
        'max-players': { min: 2, max: 12, step: 1 },
        'total-rounds': { min: 1, max: 15, step: 1 },
        'round-time': { min: 30, max: 180, step: 15 }
    };

    // --- CONFIRM DIALOG ---
    // Dialogo propio con el estilo del juego (nada de confirm() del navegador).
    // Devuelve una promesa: true si el jugador confirma, false si cancela.
    let closeConfirm = null;

    function confirmDialog({ title, message, confirmText = 'Salir', cancelText = 'Cancelar' }) {
        const overlay = $('confirm-overlay');
        $('confirm-title').textContent = title;
        $('confirm-message').textContent = message;
        $('confirm-accept').textContent = confirmText;
        $('confirm-cancel').textContent = cancelText;

        // Si ya hubiera uno abierto, se resuelve como cancelado
        if (closeConfirm) closeConfirm(false);

        overlay.hidden = false;
        overlay.classList.remove('hidden');
        // Cancelar tiene el foco: un Enter accidental no saca de la partida
        $('confirm-cancel').focus();

        return new Promise(resolve => {
            closeConfirm = (result) => {
                closeConfirm = null;
                overlay.hidden = true;
                overlay.classList.add('hidden');
                resolve(result);
            };
        });
    }

    function isConfirmOpen() {
        return closeConfirm !== null;
    }

    // Hay partida abierta mientras estemos en una sala que no ha terminado
    function hasOpenGame() {
        return !!currentRoom && currentRoom.gameState !== 'finished';
    }

    // Pregunta solo si de verdad hay algo que perder
    async function confirmLeave() {
        if (!hasOpenGame()) return true;
        const playing = currentRoom.gameState === 'playing';
        return confirmDialog({
            title: playing ? '¿Salir de la partida?' : '¿Salir de la sala?',
            message: playing
                ? 'La partida sigue en marcha. Si sales ahora pierdes tu puntuación de esta partida y el resto de jugadores continuarán sin ti.'
                : 'Saldrás de la sala y volverás al hall.',
            confirmText: playing ? 'Salir de la partida' : 'Salir de la sala'
        });
    }

    // Abandona la sala y vuelve al hall. Avisar al servidor es imprescindible:
    // si el socket se queda dentro de la sala vieja, la siguiente partida que
    // se cree conviviria con ella y las acciones irian a la equivocada.
    function leaveToLobby() {
        stopTimer();
        stopNextTimer();
        stopRestTimer();
        clearResume();
        resumeToken = null;
        currentRoom = null;
        isHost = false;
        lastQrUrl = null;
        setPendingRoom(false);
        if (socket) socket.emit('leaveRoom');
        showView('lobby-view');
    }

    async function requestLeaveToLobby() {
        if (await confirmLeave()) leaveToLobby();
    }

    // --- EVENT LISTENERS ---

    $('confirm-accept').addEventListener('click', () => closeConfirm && closeConfirm(true));
    $('confirm-cancel').addEventListener('click', () => closeConfirm && closeConfirm(false));
    // Pulsar fuera de la tarjeta cancela
    $('confirm-overlay').addEventListener('click', (e) => {
        if (e.target === $('confirm-overlay') && closeConfirm) closeConfirm(false);
    });

    // Recargar (F5, boton de recarga, barra de direcciones) o cerrar la
    // pestana con partida en curso. Es el unico gancho posible para estos
    // casos y el dialogo lo pone el navegador: no se puede maquetar ni
    // cambiarle el texto. Las teclas de recarga no se pueden interceptar,
    // el navegador las atiende antes que la pagina.
    // El valor de returnValue debe ser una cadena NO vacia: asignar '' se
    // interpreta como "no preguntes" y el aviso no aparece.
    window.addEventListener('beforeunload', (e) => {
        if (!hasOpenGame()) return;
        const msg = 'Tienes una partida en curso.';
        e.preventDefault();
        e.returnValue = msg;
        return msg;
    });


    // Setup
    $('show-auth-btn').addEventListener('click', () => {
        $('setup-guest-mode').classList.add('hidden');
        $('setup-auth-mode').classList.remove('hidden');
    });
    $('back-guest-btn').addEventListener('click', () => {
        $('setup-auth-mode').classList.add('hidden');
        $('setup-guest-mode').classList.remove('hidden');
    });

    $('play-guest-btn').addEventListener('click', async () => {
        const name = $('player-name-input').value.trim();
        if (!name || name.length < 2) {
            showError('setup-error', 'El nombre debe tener al menos 2 caracteres.');
            return;
        }
        // Los nombres de cuentas registradas estan reservados: mejor decirlo
        // aqui que dejar que falle al crear la sala
        try {
            const res = await fetch(`/api/name-available/${encodeURIComponent(name)}`);
            const data = await res.json();
            if (data.available === false) {
                showError('setup-error', `"${name}" es una cuenta registrada. Inicia sesión o usa otro nombre.`);
                return;
            }
        } catch (e) { /* si la comprobacion falla, el servidor avisara al crear */ }

        currentUser = null;
        guestName = name;
        enterLobby();
    });

    $('register-btn').addEventListener('click', async () => {
        const username = $('auth-username').value.trim();
        const password = $('auth-password').value;
        if (!username || !password) {
            showError('setup-error', 'Rellena todos los campos.');
            return;
        }
        try {
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            currentUser = { username: data.username, token: data.token };
            guestName = '';
            enterLobby();
        } catch (e) {
            showError('setup-error', e.message);
        }
    });

    $('login-btn').addEventListener('click', async () => {
        const username = $('auth-username').value.trim();
        const password = $('auth-password').value;
        if (!username || !password) {
            showError('setup-error', 'Rellena todos los campos.');
            return;
        }
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            currentUser = { username: data.username, token: data.token };
            guestName = '';
            enterLobby();
        } catch (e) {
            showError('setup-error', e.message);
        }
    });

    // Lobby
    $('create-room-btn').addEventListener('click', () => {
        if (!socket) return;
        const isPublic = $('is-public-switch').checked;
        socket.emit('createRoom', {
            playerName: playerDisplayName(),
            sessionToken: currentUser?.token,
            isPublic,
            maxPlayers: parseInt($('max-players').textContent),
            totalRounds: parseInt($('total-rounds').textContent),
            roundTime: parseInt($('round-time').textContent)
        });
        isHost = true;
        setPendingRoom(true);
    });

    $('join-room-btn').addEventListener('click', () => {
        const code = $('room-code-input').value.trim().toUpperCase();
        if (code.length !== 4) {
            showError('lobby-error', 'El código debe tener 4 letras.');
            return;
        }
        joinRoom(code);
    });

    window.joinRoom = function(code) {
        if (!socket) return;
        socket.emit('joinRoom', {
            roomCode: code,
            playerName: playerDisplayName(),
            sessionToken: currentUser?.token
        });
        isHost = false;
        setPendingRoom(true);
    };

    $('browse-rooms-btn').addEventListener('click', () => {
        socket.emit('getPublicRooms');
        showView('room-browser-view');
    });

    $('back-to-lobby-btn').addEventListener('click', () => showView('lobby-view'));

    // Room config steppers
    document.querySelectorAll('.stepper-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            const dir = parseInt(btn.dataset.dir);
            const limits = configLimits[target];
            const el = $(target);
            let val = parseInt(el.textContent) + dir * limits.step;
            val = Math.max(limits.min, Math.min(limits.max, val));
            el.textContent = val;
        });
    });

    // Waiting room
    $('start-game-btn').addEventListener('click', () => {
        socket.emit('startGame');
    });

    $('leave-room-btn').addEventListener('click', requestLeaveToLobby);

    // Game
    // Rack letters are clickable (delegated, survives innerHTML swaps)
    $('letters-display').addEventListener('click', (e) => {
        const tile = e.target.closest('.letter-tile');
        if (!tile || !$('game-view').classList.contains('active')) return;
        addBuiltLetter(tile.dataset.letter);
        animateTilePress(tile);
        vibrate(8);
    });
    $('game-exit-btn').addEventListener('click', requestLeaveToLobby);
    $('results-exit-btn').addEventListener('click', requestLeaveToLobby);
    $('backspace-btn').addEventListener('click', backspaceBuilt);
    $('clear-btn').addEventListener('click', clearBuilt);
    $('submit-built-btn').addEventListener('click', submitBuild);
    // Keyboard: forming words typing on a PC
    document.addEventListener('keydown', handleKeyboardKey);

    // Game over
    $('back-to-lobby-final').addEventListener('click', leaveToLobby);


    // Profile
    // El nombre del hall es el acceso al perfil
    $('user-badge').addEventListener('click', () => {
        if (currentUser) openProfile(currentUser.username, 'lobby-view');
    });
    $('back-from-profile-btn').addEventListener('click', () => showView(profileReturnView));

    // Amigos
    $('view-friends-btn').addEventListener('click', () => {
        if (!currentUser) return;
        showView('friends-view');
        loadFriends();
    });
    $('back-from-friends-btn').addEventListener('click', () => showView('lobby-view'));

    $('add-friend-btn').addEventListener('click', async () => {
        const name = $('add-friend-input').value.trim();
        if (!name) return showError('friends-error', 'Escribe un nombre de jugador.');
        if (await friendAction('request', name)) $('add-friend-input').value = '';
    });
    $('add-friend-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('add-friend-btn').click();
    });

    // Delegado: las listas se repintan enteras al cambiar algo
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-accept], [data-remove], [data-request], .friend-name');
        if (!btn) return;
        if (btn.dataset.accept) return void friendAction('accept', btn.dataset.accept);
        if (btn.dataset.request) return void friendAction('request', btn.dataset.request);
        if (btn.dataset.remove) return void friendAction('remove', btn.dataset.remove);
        if (btn.classList.contains('friend-name')) {
            openProfile(btn.dataset.user, 'friends-view');
        }
    });

    $('metric-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.metric-tab');
        if (!tab) return;
        document.querySelectorAll('.metric-tab').forEach(t => t.classList.toggle('active', t === tab));
        compareMetric = tab.dataset.metric;
        renderCompare();
    });

    // Logout
    $('logout-btn').addEventListener('click', async () => {
        if (!(await confirmLeave())) return;
        clearIdentity();
        currentUser = null;
        guestName = '';
        stopTimer();
        stopNextTimer();
        stopRestTimer();
        clearResume();
        resumeToken = null;
        currentRoom = null;
        isHost = false;
        lastQrUrl = null;
        if (socket) {
            socket.emit('leaveRoom');
            socket.disconnect();
        }
        socket = null;
        showView('setup-view');
    });

    // Periodic scores update
    setInterval(updateScores, 500);

    // --- ARRANQUE ---
    // Codigo de sala en la URL (enlace o QR compartido)
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode) {
        $('room-code-input').value = joinCode.toUpperCase();
    }

    // Si ya sabemos quien juega, al hall directamente; si no, a presentarse.
    // Conectar aqui es lo que permite, ademas, que un F5 en plena partida
    // reanude solo, sin volver a escribir el nombre.
    if (!(await restoreIdentity())) {
        showView('setup-view');
    } else if (joinCode && !readResume()) {
        // Venimos de un enlace de invitacion y no hay partida que reanudar:
        // entrar en la sala sin mas pasos
        joinRoom(joinCode.toUpperCase());
    }
});
