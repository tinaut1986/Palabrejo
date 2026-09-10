document.addEventListener('DOMContentLoaded', () => {
    // --- STATE ---
    let socket = null;
    let currentUser = null; // { userId, username } or null for guests
    let currentRoom = null;
    let isHost = false;
    let resumeToken = null;
    let roundTimer = null;
    let timeLeft = 0;
    let nextTimer = null;
    let roundScore = 0; // puntos de la ronda en curso (mío)

    // --- ELEMENTS ---
    const $ = id => document.getElementById(id);
    const views = ['setup-view', 'lobby-view', 'room-browser-view', 'waiting-room-view', 'game-view', 'round-results-view', 'game-over-view', 'profile-view'];

    function showView(viewId) {
        views.forEach(v => $(v).classList.remove('active'));
        $(viewId).classList.add('active');
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
        try { sessionStorage.setItem('palabreroResume', JSON.stringify({ code: roomCode, token })); } catch (e) {}
    }
    function readResume() {
        try { return JSON.parse(sessionStorage.getItem('palabreroResume') || 'null'); } catch (e) { return null; }
    }
    function clearResume() {
        try { sessionStorage.removeItem('palabreroResume'); } catch (e) {}
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
            if (resumeToken || currentRoom) {
                // The game context is gone or unrecoverable -> back to lobby
                clearResume();
                resumeToken = null;
                currentRoom = null;
                showView('lobby-view');
            }
        });

        socket.on('roomStateUpdate', (state) => {
            currentRoom = state;
            isHost = state.players.find(p => p.id === socket.id)?.isHost;
            updateWaitingRoom(state);
        });

        socket.on('roundStart', (data) => {
            stopNextTimer();
            showView('game-view');
            $('round-display').textContent = `Ronda ${data.round}/${currentRoom.totalRounds}`;

            rackLetters = data.letters.map(l => canonicalLetter(l));
            builtWord = [];
            $('letters-display').innerHTML = data.letters
                .map(l => `<button type="button" class="letter-tile" data-letter="${l}">${l}</button>`)
                .join('');
            renderBuiltWord();
            myWords = [];
            renderMyWords();
            roundScore = 0;
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
            showGameOver(data);
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

        // QR
        const joinUrl = `${window.location.origin}?join=${state.code}`;
        generateQRCode(joinUrl, $('qr-canvas'));

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
    async function loadProfile(username) {
        try {
            const res = await fetch(`/api/profile/${username}`);
            if (!res.ok) throw new Error('No encontrado');
            const data = await res.json();

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

    // --- ROOM CONFIG ---
    const configDefaults = { 'max-players': 8, 'total-rounds': 5, 'round-time': 90 };
    const configLimits = {
        'max-players': { min: 2, max: 12, step: 1 },
        'total-rounds': { min: 1, max: 15, step: 1 },
        'round-time': { min: 30, max: 180, step: 15 }
    };

    // --- EVENT LISTENERS ---

    // Setup
    $('show-auth-btn').addEventListener('click', () => {
        $('setup-guest-mode').classList.add('hidden');
        $('setup-auth-mode').classList.remove('hidden');
    });
    $('back-guest-btn').addEventListener('click', () => {
        $('setup-auth-mode').classList.add('hidden');
        $('setup-guest-mode').classList.remove('hidden');
    });

    $('play-guest-btn').addEventListener('click', () => {
        const name = $('player-name-input').value.trim();
        if (!name || name.length < 2) {
            showError('setup-error', 'El nombre debe tener al menos 2 caracteres.');
            return;
        }
        currentUser = null;
        connectSocket();
        showView('lobby-view');
        $('user-badge').textContent = `👤 ${name} (invitado)`;
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

            currentUser = { userId: data.userId, username: data.username };
            connectSocket();
            showView('lobby-view');
            $('user-badge').textContent = `🎮 ${data.username}`;
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

            currentUser = { userId: data.userId, username: data.username };
            connectSocket();
            showView('lobby-view');
            $('user-badge').textContent = `🎮 ${data.username}`;
        } catch (e) {
            showError('setup-error', e.message);
        }
    });

    // Lobby
    $('create-room-btn').addEventListener('click', () => {
        if (!socket) return;
        const isPublic = $('is-public-switch').checked;
        socket.emit('createRoom', {
            playerName: currentUser ? currentUser.username : $('player-name-input').value.trim(),
            isPublic,
            maxPlayers: parseInt($('max-players').textContent),
            totalRounds: parseInt($('total-rounds').textContent),
            roundTime: parseInt($('round-time').textContent),
            userId: currentUser?.userId
        });
        isHost = true;
        showView('waiting-room-view');
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
            playerName: currentUser ? currentUser.username : $('player-name-input').value.trim(),
            userId: currentUser?.userId
        });
        isHost = false;
        showView('waiting-room-view');
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

    $('leave-room-btn').addEventListener('click', () => {
        clearResume();
        resumeToken = null;
        currentRoom = null;
        if (socket) socket.disconnect();
        socket = null;
        showView('lobby-view');
        connectSocket();
    });

    // Game
    // Rack letters are clickable (delegated, survives innerHTML swaps)
    $('letters-display').addEventListener('click', (e) => {
        const tile = e.target.closest('.letter-tile');
        if (!tile || !$('game-view').classList.contains('active')) return;
        addBuiltLetter(tile.dataset.letter);
        animateTilePress(tile);
        vibrate(8);
    });
    $('backspace-btn').addEventListener('click', backspaceBuilt);
    $('clear-btn').addEventListener('click', clearBuilt);
    $('submit-built-btn').addEventListener('click', submitBuild);
    // Keyboard: forming words typing on a PC
    document.addEventListener('keydown', handleKeyboardKey);

    // Game over
    $('back-to-lobby-final').addEventListener('click', () => {
        clearResume();
        resumeToken = null;
        currentRoom = null;
        showView('lobby-view');
    });

    // Profile
    $('view-profile-btn').addEventListener('click', () => {
        if (currentUser) {
            loadProfile(currentUser.username);
            showView('profile-view');
        }
    });
    $('back-from-profile-btn').addEventListener('click', () => showView('lobby-view'));

    // Logout
    $('logout-btn').addEventListener('click', () => {
        currentUser = null;
        clearResume();
        resumeToken = null;
        currentRoom = null;
        if (socket) socket.disconnect();
        socket = null;
        showView('setup-view');
    });

    // Periodic scores update
    setInterval(updateScores, 500);

    // Check for ?join=CODE in URL
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode) {
        $('room-code-input').value = joinCode;
    }
});
