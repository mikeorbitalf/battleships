// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.static('public'));
const PORT = process.env.PORT || 3000;

// ----- Game constants -----
const BOARD_SIZE = 10;
const SHIP_DEFS = [
  { key: 'carrier', name: 'Carrier', size: 5, count: 1 },
  { key: 'battleship', name: 'Battleship', size: 4, count: 1 },
  { key: 'cruiser', name: 'Cruiser', size: 3, count: 1 },
  { key: 'submarine', name: 'Submarine', size: 3, count: 1 },
  { key: 'destroyer', name: 'Destroyer', size: 2, count: 1 },
];

const PHASES = {
  LOBBY: 'lobby',
  PLACING: 'placing',
  IN_PROGRESS: 'in-progress',
  FINISHED: 'finished',
};

// ----- Game state -----
let state = initialState();

function initialState() {
  return {
    phase: PHASES.LOBBY,
    players: {
      1: mkPlayerState(),
      2: mkPlayerState(),
    },
    turn: null, // 1 or 2
    winner: null, // 1 or 2
    createdAt: Date.now(),
  };
}

function mkPlayerState() {
  return {
    socketId: null,
    name: null, // "Player 1" / "Player 2"
    ready: false,
    board: {}, // map "r,c" -> { shipId, hit: bool }
    ships: {}, // shipId -> { name, size, hits: Set("r,c") }
    shotsTaken: new Set(), // of "r,c"
  };
}

function broadcast() {
  const safe = publicState();
  io.emit('state', safe);
}

function publicState() {
  // Do not expose opponent ship locations; only expose:
  // - your own board fully
  // - opponent board as hit/miss only
  const base = {
    phase: state.phase,
    turn: state.turn,
    winner: state.winner,
    players: {
      1: scrubPlayer(1),
      2: scrubPlayer(2),
    },
  };
  return base;
}

function scrubPlayer(pn) {
  const p = state.players[pn];
  return {
    connected: !!p.socketId,
    ready: p.ready,
    name: p.name,
    // board exposure is handled client-side per viewer via targeted emits too
  };
}

function resetGame(soft = false) {
  const prev = state;
  state = initialState();
  // keep connections & names
  for (const pn of [1, 2]) {
    state.players[pn].socketId = prev.players[pn].socketId;
    state.players[pn].name = prev.players[pn].name;
  }
  state.phase = PHASES.PLACING; // move straight into placing if players are seated
  if (!state.players[1].socketId || !state.players[2].socketId) {
    state.phase = PHASES.LOBBY;
  }
  broadcast();
}

// Validate placement payload from client
function validatePlacement(payload) {
  // payload: [{ key, name, cells: [{r,c}, ...] }, ...]
  if (!Array.isArray(payload))
    return { ok: false, msg: 'Invalid placement format.' };

  // Count and sizes
  const required = {};
  for (const d of SHIP_DEFS) required[d.key] = d.size;

  const seenKeys = new Set();
  const occupied = new Set();

  for (const ship of payload) {
    if (!ship || typeof ship !== 'object')
      return { ok: false, msg: 'Invalid ship object.' };
    const { key, name, cells } = ship;
    if (!required[key])
      return { ok: false, msg: `Unexpected ship key: ${key}` };
    if (seenKeys.has(key)) return { ok: false, msg: `Duplicate ship: ${key}` };
    seenKeys.add(key);

    if (!Array.isArray(cells) || cells.length !== required[key]) {
      return { ok: false, msg: `${name || key} has incorrect size.` };
    }

    // Ensure linear and contiguous
    const rows = cells.map((c) => c.r);
    const cols = cells.map((c) => c.c);
    const sameRow = rows.every((r) => r === rows[0]);
    const sameCol = cols.every((c) => c === cols[0]);
    if (!sameRow && !sameCol)
      return { ok: false, msg: `${name || key} must be straight.` };

    // bounds & duplicates
    for (const { r, c } of cells) {
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
        return { ok: false, msg: 'Placement out of bounds.' };
      }
      const k = `${r},${c}`;
      if (occupied.has(k)) return { ok: false, msg: 'Ships cannot overlap.' };
      occupied.add(k);
    }

    // contiguity
    const sorted = cells
      .slice()
      .sort((a, b) => (sameRow ? a.c - b.c : a.r - b.r));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (sameRow && cur.c !== prev.c + 1)
        return { ok: false, msg: 'Gaps in ship cells.' };
      if (sameCol && cur.r !== prev.r + 1)
        return { ok: false, msg: 'Gaps in ship cells.' };
    }
  }

  // ensure all required ships present
  const allKeys = SHIP_DEFS.map((s) => s.key);
  for (const k of allKeys) {
    if (!seenKeys.has(k)) return { ok: false, msg: `Missing ship: ${k}` };
  }

  return { ok: true };
}

function setPlacementForPlayer(pn, shipsPayload) {
  const valid = validatePlacement(shipsPayload);
  if (!valid.ok) return valid;

  const p = state.players[pn];
  p.board = {};
  p.ships = {};
  for (const ship of shipsPayload) {
    const shipId = ship.key; // unique per player set
    p.ships[shipId] = {
      name: ship.name,
      size: ship.cells.length,
      hits: new Set(),
    };
    for (const { r, c } of ship.cells) {
      p.board[`${r},${c}`] = { shipId, hit: false };
    }
  }
  return { ok: true };
}

function allShipsSunk(pn) {
  const p = state.players[pn];
  // every ship's hits size == ship size
  return Object.values(p.ships).every((s) => s.hits.size === s.size);
}

function sendPrivateBoards() {
  // Send each player their own full board and the opponent's redacted board
  for (const viewer of [1, 2]) {
    const vs = state.players[viewer];
    if (!vs.socketId) continue;

    const myBoard = state.players[viewer].board;
    const myShips = state.players[viewer].ships;

    const opp = viewer === 1 ? 2 : 1;
    const oppShots = state.players[viewer].shotsTaken; // what I shot
    const oppBoardPublic = {}; // only hit/miss info from my perspective

    // Build a fog board with only results of my shots
    // We'll mark "H" for hit, "M" for miss
    for (const shot of oppShots) {
      const cell = state.players[opp].board[shot];
      if (cell && cell.hit) {
        oppBoardPublic[shot] = { result: 'H' };
      } else {
        oppBoardPublic[shot] = { result: 'M' };
      }
    }

    io.to(vs.socketId).emit('boards', {
      you: { board: myBoard, ships: summarizeShips(myShips) },
      opponent: { fog: oppBoardPublic },
    });
  }
}

function summarizeShips(ships) {
  const sum = {};
  for (const [id, s] of Object.entries(ships)) {
    sum[id] = { name: s.name, size: s.size, hits: Array.from(s.hits) };
  }
  return sum;
}

// ----- Socket handling -----
io.on('connection', (socket) => {
  // Spectators can join too; they can chat but not play
  socket.emit('hello', { msg: 'Welcome to Battleships!' });
  socket.emit('state', publicState());

  socket.on('join', ({ slot }) => {
    if (slot !== 1 && slot !== 2) return;
    const other = slot === 1 ? 2 : 1;
    // seat if empty or same socket reclaims seat
    if (
      state.players[slot].socketId &&
      state.players[slot].socketId !== socket.id
    ) {
      socket.emit('notice', {
        type: 'error',
        text: 'That slot is already taken.',
      });
      return;
    }
    // if sitting in the other seat already, remove from there
    if (state.players[other].socketId === socket.id) {
      state.players[other] = mkPlayerState();
    }
    state.players[slot].socketId = socket.id;
    state.players[slot].name = `Player ${slot}`;
    state.players[slot].ready = false;
    state.players[slot].board = {};
    state.players[slot].ships = {};
    state.players[slot].shotsTaken = new Set();

    socket.emit('joined', { slot });

    if (
      state.phase === PHASES.LOBBY &&
      state.players[1].socketId &&
      state.players[2].socketId
    ) {
      state.phase = PHASES.PLACING;
    }
    broadcast();
    sendPrivateBoards();
  });

  socket.on('placeShips', ({ slot, ships }) => {
    const pn = slot;
    if (pn !== 1 && pn !== 2) return;
    if (state.players[pn].socketId !== socket.id) return;
    if (state.phase !== PHASES.PLACING && state.phase !== PHASES.LOBBY) return;

    const res = setPlacementForPlayer(pn, ships);
    if (!res.ok) {
      socket.emit('notice', { type: 'error', text: res.msg });
      return;
    }
    state.players[pn].ready = false; // place first, then explicitly ready
    broadcast();
    sendPrivateBoards();
    socket.emit('notice', { type: 'ok', text: 'Placement saved.' });
  });

  socket.on('ready', ({ slot }) => {
    const pn = slot;
    if (pn !== 1 && pn !== 2) return;
    if (state.players[pn].socketId !== socket.id) return;

    // must have placed all ships
    if (Object.keys(state.players[pn].ships).length !== SHIP_DEFS.length) {
      socket.emit('notice', { type: 'error', text: 'Place all ships first.' });
      return;
    }
    state.players[pn].ready = true;

    if (state.players[1].ready && state.players[2].ready) {
      state.phase = PHASES.IN_PROGRESS;
      state.turn = Math.random() < 0.5 ? 1 : 2;
    }
    broadcast();
    sendPrivateBoards();
  });

  socket.on('fire', ({ slot, r, c }) => {
    const pn = slot;
    if (state.phase !== PHASES.IN_PROGRESS) return;
    if (pn !== 1 && pn !== 2) return;
    if (state.players[pn].socketId !== socket.id) return;
    if (state.turn !== pn) return;

    const shooter = state.players[pn];
    const oppn = pn === 1 ? 2 : 1;
    const target = state.players[oppn];

    const key = `${r},${c}`;
    if (shooter.shotsTaken.has(key)) {
      socket.emit('notice', {
        type: 'error',
        text: 'You already fired there.',
      });
      return;
    }
    shooter.shotsTaken.add(key);

const cell = target.board[key];
let result = 'miss';
let sunkShip = null;

if (cell && !cell.hit) {
  cell.hit = true;
  result = 'hit';
  const sh = target.ships[cell.shipId];
  sh.hits.add(key);
  if (sh.hits.size === sh.size) {
    sunkShip = sh.name;
  }
} else if (cell && cell.hit) {
  result = 'hit';
}



    // check end
    if (allShipsSunk(oppn)) {
      state.phase = PHASES.FINISHED;
      state.winner = pn;
    } else {
      // swap turn
      state.turn = oppn;
    }

    io.emit('shotResult', {
      by: pn,
      at: { r, c },
      result,
      sunkShip,
      nextTurn: state.turn,
      phase: state.phase,
      winner: state.winner,
    });

    sendPrivateBoards();
    broadcast();
  });

  socket.on('chat', ({ from, text }) => {
    const maxLen = 400;
    const clean = String(text || '').slice(0, maxLen);
    if (!clean.trim()) return;

    let label = 'Spectator';
    for (const pn of [1, 2]) {
      if (state.players[pn].socketId === socket.id) label = `Player ${pn}`;
    }
    io.emit('chat', {
      from: from || label,
      text: clean,
      ts: Date.now(),
    });
  });

  socket.on('reset', () => {
    // only seated players may reset
    if (Object.values(state.players).some((p) => p.socketId === socket.id)) {
      resetGame();
    }
  });

  socket.on('disconnect', () => {
    // free their seat, keep game but likely return to lobby
    for (const pn of [1, 2]) {
      if (state.players[pn].socketId === socket.id) {
        state.players[pn] = mkPlayerState();
      }
    }
    if (!state.players[1].socketId || !state.players[2].socketId) {
      state.phase = PHASES.LOBBY;
      state.turn = null;
      state.winner = null;
    }
    broadcast();
  });
});

server.listen(PORT, () => {
  console.log(`Battleships server running at http://localhost:${PORT}`);
});
