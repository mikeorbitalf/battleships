/* client.js */
const BOARD_SIZE = 10;
const SHIPS = [
  { key: 'carrier', name: 'Carrier', size: 5 },
  { key: 'battleship', name: 'Battleship', size: 4 },
  { key: 'cruiser', name: 'Cruiser', size: 3 },
  { key: 'submarine', name: 'Submarine', size: 3 },
  { key: 'destroyer', name: 'Destroyer', size: 2 },
];

const socket = io();

let mySlot = null; // 1 or 2, or null if spectator
let phase = 'lobby';
let turn = null;
let winner = null;

// local placement model (cells per ship)
let myPlacement = null; // [{key,name,cells:[{r,c}...]}]
let myBoard = {}; // from server (includes hits)
let oppFog = {}; // what we know about enemy via shots (H/M)

const el = (id) => document.getElementById(id);

// Build boards UI
const yourBoardEl = el('yourBoard');
const oppBoardEl = el('oppBoard');
const phaseEl = el('phase');
const turnEl = el('turn');
const youAreEl = el('youAre');
const chatLog = el('chatLog');

buildBoard(yourBoardEl, false);
buildBoard(oppBoardEl, true);

function buildBoard(container, isAttack) {
  container.innerHTML = '';
  container.style.setProperty('--size', BOARD_SIZE);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      if (isAttack) {
        cell.addEventListener('click', () => tryFire(r, c));
      }
      container.appendChild(cell);
    }
  }
}

function updateLabels() {
  phaseEl.textContent = `Phase: ${prettyPhase(phase)}`;
  turnEl.textContent =
    phase === 'in-progress'
      ? `Turn: Player ${turn}`
      : phase === 'finished'
      ? `Winner: Player ${winner}`
      : 'Turn: —';
  youAreEl.textContent = `You: ${mySlot ? 'Player ' + mySlot : 'Spectator'}`;
}

function prettyPhase(p) {
  return (
    {
      lobby: 'Lobby',
      placing: 'Placing',
      'in-progress': 'In Progress',
      finished: 'Finished',
    }[p] || p
  );
}

function renderBoards() {
  // Your board
  for (const cell of yourBoardEl.children) {
    const r = +cell.dataset.r,
      c = +cell.dataset.c;
    cell.className = 'cell';
    const k = `${r},${c}`;
    const mine = myBoard[k];
    if (mine && mine.shipId) cell.classList.add('ship');
    if (mine && mine.hit) cell.classList.add('hit');
    if (mine && !mine.hit && mine.shipId) cell.classList.add('ship-intact');
    if (mine && mine.miss) cell.classList.add('miss');


  }

  // Opponent board (fog)
// Opponent board
for (const cell of oppBoardEl.children) {
  const r = +cell.dataset.r,
    c = +cell.dataset.c;
  cell.className = 'cell';
  const k = `${r},${c}`;

  if (window._oppFullBoard) {
    // GAME OVER: show full board
    const oppCell = window._oppFullBoard[k];
    if (oppCell && oppCell.shipId) cell.classList.add('ship');
    if (oppCell && oppCell.hit) cell.classList.add('hit');
  } else {
    // Normal fog of war
    const seen = oppFog[k];
    if (seen) {
      if (seen.result === 'H') cell.classList.add('hit');
      if (seen.result === 'M') cell.classList.add('miss');
    }
    if (phase === 'in-progress' && mySlot && turn === mySlot && !seen) {
      cell.classList.add('aim');
    }
  }
}


  renderShipStatus();
}

function renderShipStatus() {
  const wrap = document.getElementById('yourShips');
  wrap.innerHTML = '';
  if (!myPlacement) return;
  const list = document.createElement('ul');
  for (const s of SHIPS) {
    const li = document.createElement('li');
    li.textContent = `${s.name} (${s.size})`;
    // show hit progress if we have it
    // server sends summarizeShips in "you.ships"
    if (window._youShips && window._youShips[s.key]) {
      const info = window._youShips[s.key];
      const sunk = info.hits.length >= info.size;
      li.innerHTML = `<span class="${sunk ? 'sunk' : ''}">${
        s.name
      }</span> <small>${info.hits.length}/${info.size} hits</small>`;
    }
    list.appendChild(li);
  }
  wrap.appendChild(list);
}

function tryFire(r, c) {
  if (!mySlot) return;
  if (phase !== 'in-progress') return;
  if (turn !== mySlot) return;

  const k = `${r},${c}`;
  if (oppFog[k]) return; // already shot here

  socket.emit('fire', { slot: mySlot, r, c });
}

function randomizePlacement() {
  // produce placement that matches SHIPS
  const grid = Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill(0)
  );
  const placement = [];

  for (const ship of SHIPS) {
    let placed = false;
    for (let tries = 0; tries < 500 && !placed; tries++) {
      const dir = Math.random() < 0.5 ? 'H' : 'V';
      const r0 = Math.floor(Math.random() * BOARD_SIZE);
      const c0 = Math.floor(Math.random() * BOARD_SIZE);
      const cells = [];
      for (let i = 0; i < ship.size; i++) {
        const r = r0 + (dir === 'V' ? i : 0);
        const c = c0 + (dir === 'H' ? i : 0);
        if (r >= BOARD_SIZE || c >= BOARD_SIZE) {
          cells.length = 0;
          break;
        }
        cells.push({ r, c });
      }
      if (!cells.length) continue;

      // check overlap
      if (cells.some(({ r, c }) => grid[r][c] === 1)) continue;

      // commit
      for (const { r, c } of cells) grid[r][c] = 1;
      placement.push({ key: ship.key, name: ship.name, cells });
      placed = true;
    }
    if (!placed) {
      // fallback: restart
      return randomizePlacement();
    }
  }
  myPlacement = placement;
  drawLocalPlacement();
}

function drawLocalPlacement() {
  // paint your board with local placement (before server echo)
  myBoard = {};
  for (const p of myPlacement) {
    for (const { r, c } of p.cells) {
      myBoard[`${r},${c}`] = { shipId: p.key, hit: false };
    }
  }
  renderBoards();
}

function sendPlacement() {
  if (!mySlot) return;
  if (!myPlacement) randomizePlacement();
  socket.emit('placeShips', { slot: mySlot, ships: myPlacement });
}

function readyUp() {
  if (!mySlot) return;
  socket.emit('ready', { slot: mySlot });
}

// ---- UI hooks ----
el('joinP1').onclick = () => socket.emit('join', { slot: 1 });
el('joinP2').onclick = () => socket.emit('join', { slot: 2 });
el('randomize').onclick = () => {
  randomizePlacement();
  sendPlacement();
};
el('ready').onclick = () => readyUp();
el('reset').onclick = () => socket.emit('reset');

const chatForm = el('chatForm');
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el('chatName').value.trim();
  const text = el('chatInput').value.trim();
  if (!text) return;
  socket.emit('chat', { from: name, text });
  el('chatInput').value = '';
});

// ---- Socket events ----
socket.on('hello', () => {});
socket.on('notice', ({ type, text }) => toast(text, type));
socket.on('state', (s) => {
  const ps = document.getElementById('playersStatus');
  if (ps) {
    ps.innerHTML = `
      <div>P1: ${s.players[1].connected ? '🟢' : '⚫'} ${
      s.players[1].name || '—'
    } ${s.players[1].ready ? '✅ Ready' : ''}</div>
      <div>P2: ${s.players[2].connected ? '🟢' : '⚫'} ${
      s.players[2].name || '—'
    } ${s.players[2].ready ? '✅ Ready' : ''}</div>
    `;
  }

  phase = s.phase;
  turn = s.turn;
  winner = s.winner;
  // maintain mySlot if already set; otherwise infer if this socket holds a seat
  if (!mySlot) {
    for (const pn of [1, 2]) {
      // we can’t see socketId here; remain spectator until we place/join
    }
  }
  updateLabels();
});

socket.on('boards', ({ you, opponent }) => {
  myBoard = you.board || {};
  window._youShips = you.ships || {};

  if (opponent.full) {
    // GAME OVER: show all opponent ships
    oppFog = {}; // clear fog
    window._oppFullBoard = opponent.full;
    window._oppShips = opponent.ships;
  } else {
    window._oppFullBoard = null;
    window._oppShips = null;
    oppFog = opponent.fog || {};
  }

  renderBoards();
});


socket.on(
  'shotResult',
  ({ by, at, result, sunkShip, nextTurn, phase: ph, winner: w }) => {
    phase = ph;
    winner = w;
    turn = nextTurn;
    const k = `${at.r},${at.c}`;
    if (by === mySlot) {
      // This was my shot; update fog
      oppFog[k] = { result: result === 'hit' ? 'H' : 'M' };
    }
    // Small toast
    const text =
      result === 'hit'
        ? sunkShip
          ? `💥 HIT & SUNK ${sunkShip}!`
          : '💥 HIT!'
        : '💧 Miss.';
    toast(text, result === 'hit' ? 'ok' : 'info');
    updateLabels();
    renderBoards();
  }
);

socket.on('chat', ({ from, text, ts }) => {
  const row = document.createElement('div');
  row.className = 'msg';
  const time = new Date(ts).toLocaleTimeString();
  row.innerHTML = `<span class="from">${escapeHtml(
    from || 'Anon'
  )}</span> <span class="time">${time}</span><div class="bubble">${escapeHtml(
    text
  )}</div>`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
});

// ---- Helpers ----
function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[
        ch
      ])
  );
}

function toast(text, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'));
  setTimeout(() => t.classList.remove('show'), 2200);
  setTimeout(() => t.remove(), 2800);
}

socket.on('joined', ({ slot }) => {
  mySlot = slot;
  updateLabels();
});

// Initial local setup
updateLabels();
randomizePlacement(); // prefill placement visually
