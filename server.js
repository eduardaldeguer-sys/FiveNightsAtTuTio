const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  30000,
  pingInterval: 10000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Room store ───────────────────────────────────────────────────────────────
// rooms[code] = {
//   code, hostId,
//   players: [{ id, name, role: 'guard'|'uncle', uncle: 'pepe'|'carlos'|'manolo'|'paco' }],
//   gameState: { ... } | null,
//   started: false,
// }
const rooms = {};

const UNCLE_NAMES = ['pepe', 'carlos', 'manolo', 'paco'];
const UNCLE_DISPLAY = { pepe:'Tío Pepe', carlos:'Tío Carlos', manolo:'Tío Manolo', paco:'Tío Paco' };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getRoom(code) { return rooms[code] || null; }

function publicPlayers(room) {
  return room.players.map(p => ({
    name:  p.name,
    role:  p.role,
    uncle: p.uncle || null,
    ready: p.ready || false,
  }));
}

// Initial game state
function makeGameState(night = 1) {
  return {
    night,
    active:          false,
    hour:            12,
    amPm:            'AM',
    power:           100,
    powerDepleted:   false,
    leftDoorClosed:  false,
    rightDoorClosed: false,
    cameraOpen:      false,
    activeCam:       'cam-1A',
    guardCam:        'cam-1A',
    unclePositions: { pepe: 'cam-1A', carlos: 'cam-3A', manolo: 'cam-6', paco: 'cam-5' },
    uncleAtDoor:    { pepe: false, carlos: false, manolo: false, paco: false },
    uncleDoorSide:  { pepe: 'left', carlos: 'right', manolo: 'left', paco: 'right' },
    uncleActive:    { pepe: true, carlos: false, manolo: false, paco: false },
    elapsedMs:       0,
    result:          null,   // null | 'guard-wins' | 'uncles-win'
    winner:          null,
  };
}

// Activation by night
function setUncleActiveForNight(gs, night) {
  gs.uncleActive.pepe   = true;
  gs.uncleActive.carlos = night >= 2;
  gs.uncleActive.manolo = night >= 3;
  gs.uncleActive.paco   = night >= 4;
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Create room ────────────────────────────────────────────────────────────
  socket.on('create-room', ({ name }) => {
    name = String(name || 'Guardia').slice(0, 20);
    let code;
    do { code = genCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      hostId:  socket.id,
      players: [{ id: socket.id, name, role: 'guard', ready: false }],
      started: false,
      gameState: null,
      night:   1,
    };
    socket.join(code);
    socket.data.roomCode = code;

    socket.emit('room-created', { code, role: 'guard', players: publicPlayers(rooms[code]) });
    console.log(`[${code}] Created by ${name}`);
  });

  // ── Join room ───────────────────────────────────────────────────────────────
  socket.on('join-room', ({ code, name }) => {
    code = String(code || '').toUpperCase().trim();
    name = String(name || 'Jugador').slice(0, 20);
    const room = getRoom(code);
    if (!room)           { socket.emit('join-error', 'Sala no encontrada'); return; }
    if (room.started)    { socket.emit('join-error', 'La partida ya empezó'); return; }
    if (room.players.length >= 5) { socket.emit('join-error', 'Sala llena (máx. 5)'); return; }

    // Assign next available uncle
    const taken = room.players.filter(p => p.role === 'uncle').map(p => p.uncle);
    const uncle = UNCLE_NAMES.find(u => !taken.includes(u));
    if (!uncle) { socket.emit('join-error', 'Todos los tíos están ocupados'); return; }

    room.players.push({ id: socket.id, name, role: 'uncle', uncle, ready: false });
    socket.join(code);
    socket.data.roomCode = code;

    socket.emit('room-joined', { code, role: 'uncle', uncle, players: publicPlayers(room) });
    io.to(code).emit('lobby-update', { players: publicPlayers(room) });
    console.log(`[${code}] ${name} joined as ${UNCLE_DISPLAY[uncle]}`);
  });

  // ── Player ready ────────────────────────────────────────────────────────────
  socket.on('player-ready', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.ready = true;
    io.to(code).emit('lobby-update', { players: publicPlayers(room) });
  });

  // ── Start game (host only) ──────────────────────────────────────────────────
  socket.on('start-game', ({ night }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id || room.started) return;

    night = Math.min(5, Math.max(1, parseInt(night) || 1));
    room.night     = night;
    room.started   = true;
    room.gameState = makeGameState(night);
    setUncleActiveForNight(room.gameState, night);

    // Mark which uncles are human-controlled
    const humanUncles = room.players.filter(p => p.role === 'uncle').map(p => p.uncle);
    room.gameState.humanUncles = humanUncles;

    io.to(code).emit('game-start', {
      gameState: room.gameState,
      players:   publicPlayers(room),
    });
    console.log(`[${code}] Game started — Night ${night}`);
  });

  // ── Guard actions (sent by guard client periodically) ──────────────────────
  socket.on('guard-state', (data) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || !room.started) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p || p.role !== 'guard') return;

    const gs = room.gameState;
    gs.power           = data.power           ?? gs.power;
    gs.powerDepleted   = data.powerDepleted   ?? gs.powerDepleted;
    gs.leftDoorClosed  = data.leftDoorClosed  ?? gs.leftDoorClosed;
    gs.rightDoorClosed = data.rightDoorClosed ?? gs.rightDoorClosed;
    gs.cameraOpen      = data.cameraOpen      ?? gs.cameraOpen;
    gs.activeCam       = data.activeCam       ?? gs.activeCam;
    gs.hour            = data.hour            ?? gs.hour;
    gs.amPm            = data.amPm            ?? gs.amPm;
    gs.elapsedMs       = data.elapsedMs       ?? gs.elapsedMs;

    // Broadcast to uncle players
    socket.to(code).emit('guard-update', {
      power:           gs.power,
      powerDepleted:   gs.powerDepleted,
      leftDoorClosed:  gs.leftDoorClosed,
      rightDoorClosed: gs.rightDoorClosed,
      cameraOpen:      gs.cameraOpen,
      activeCam:       gs.activeCam,
      hour:            gs.hour,
      amPm:            gs.amPm,
      elapsedMs:       gs.elapsedMs,
    });
  });

  // ── Uncle move (human uncle player moves their uncle) ──────────────────────
  socket.on('uncle-move', ({ targetCam }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || !room.started) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p || p.role !== 'uncle') return;

    const VALID_CAMS = ['cam-1A','cam-1B','cam-2A','cam-3A','cam-4A','cam-4B','cam-5','cam-6','cam-7','cam-8'];
    if (!VALID_CAMS.includes(targetCam)) return;

    const gs = room.gameState;
    if (!gs.uncleActive[p.uncle]) return; // uncle not active yet

    gs.unclePositions[p.uncle] = targetCam;
    gs.uncleAtDoor[p.uncle]    = false;

    io.to(code).emit('uncle-moved', {
      uncle:    p.uncle,
      cam:      targetCam,
      atDoor:   false,
      byPlayer: p.name,
    });
    console.log(`[${code}] ${UNCLE_DISPLAY[p.uncle]} moved to ${targetCam}`);
  });

  // ── Uncle rush door ─────────────────────────────────────────────────────────
  socket.on('uncle-rush', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || !room.started) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p || p.role !== 'uncle') return;

    const gs = room.gameState;
    if (!gs.uncleActive[p.uncle]) return;

    const side = gs.uncleDoorSide[p.uncle];
    gs.uncleAtDoor[p.uncle]    = true;
    gs.unclePositions[p.uncle] = side === 'left' ? 'cam-4A' : 'cam-4B';

    io.to(code).emit('uncle-at-door', {
      uncle:  p.uncle,
      side,
      byPlayer: p.name,
    });
    console.log(`[${code}] ${UNCLE_DISPLAY[p.uncle]} rushed to ${side} door!`);
  });

  // ── Uncle retreat ──────────────────────────────────────────────────────────
  socket.on('uncle-retreat', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || !room.started) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p || p.role !== 'uncle') return;

    const gs = room.gameState;
    gs.uncleAtDoor[p.uncle] = false;
    gs.unclePositions[p.uncle] = p.uncle === 'manolo' ? 'cam-6' : 'cam-1A';

    io.to(code).emit('uncle-moved', { uncle: p.uncle, cam: gs.unclePositions[p.uncle], atDoor: false, byPlayer: p.name });
  });

  // ── Guard reports jumpscare (uncles win) ────────────────────────────────────
  socket.on('guard-caught', ({ uncleName }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || !room.started) return;
    room.gameState.result = 'uncles-win';
    room.gameState.winner = uncleName;
    room.started = false;
    io.to(code).emit('game-over', { result: 'uncles-win', winner: uncleName });
    console.log(`[${code}] Uncles win! ${UNCLE_DISPLAY[uncleName] || uncleName} caught the guard`);
  });

  // ── Guard survives 6AM (guard wins) ─────────────────────────────────────────
  socket.on('guard-survived', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || !room.started) return;
    room.gameState.result = 'guard-wins';
    room.started = false;
    io.to(code).emit('game-over', { result: 'guard-wins', winner: null });
    console.log(`[${code}] Guard survived the night!`);
  });

  // ── Chat message ────────────────────────────────────────────────────────────
  socket.on('chat', ({ text }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;
    text = String(text || '').slice(0, 100);
    io.to(code).emit('chat', { name: p.name, text, role: p.role, uncle: p.uncle });
  });

  // ── Rematch ─────────────────────────────────────────────────────────────────
  socket.on('rematch', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    room.started   = false;
    room.gameState = null;
    room.players.forEach(p => p.ready = false);
    io.to(code).emit('rematch', { players: publicPlayers(room) });
  });

  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const left = room.players[idx];
    room.players.splice(idx, 1);

    if (room.players.length === 0) {
      delete rooms[code];
      console.log(`[${code}] Room deleted (empty)`);
      return;
    }

    // If host left, reassign
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.players[0].role = 'guard';
    }

    io.to(code).emit('player-left', { name: left.name, players: publicPlayers(room) });
    if (room.started) {
      io.to(code).emit('game-over', { result: 'disconnect', winner: null, message: `${left.name} se desconectó` });
      room.started = false;
    }
    console.log(`[${code}] ${left.name} disconnected`);
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 5 Noches con mi Tío — Multijugador`);
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
