const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms[code] = { state, position, timestamp, fileInfo, users[] }
const rooms = {};

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      state: 'paused',
      position: 0,
      timestamp: Date.now(),
      fileInfo: null,
      users: []
    };
  }
  return rooms[code];
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // ── JOIN ──────────────────────────────────────────────────
  socket.on('join-room', ({ roomCode, username }) => {
    currentRoom = roomCode;
    currentUser = username;
    socket.join(roomCode);

    const room = getOrCreateRoom(roomCode);
    room.users.push({ id: socket.id, username });

    // Tell the joiner the current room state
    socket.emit('room-state', {
      state: room.state,
      position: room.position,
      timestamp: room.timestamp,
      fileInfo: room.fileInfo,
      userCount: room.users.length
    });

    // Tell everyone else someone joined
    socket.to(roomCode).emit('peer-joined', { username });
    io.to(roomCode).emit('user-count', room.users.length);

    console.log(`[${roomCode}] ${username} joined (${room.users.length}/2)`);
  });

  // ── FILE INFO ─────────────────────────────────────────────
  socket.on('file-info', ({ roomCode, fileInfo }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Always broadcast to peer so they can show the thumbnail name/meta
    socket.to(roomCode).emit('peer-file-info', { fileInfo });

    if (!room.fileInfo) {
      room.fileInfo = fileInfo;
      socket.emit('file-status', {
        status: 'waiting',
        message: 'Waiting for your friend to select their file...'
      });
    } else {
      const a = room.fileInfo;
      const b = fileInfo;
      const sizeMatch = a.size === b.size;
      const durationMatch = Math.abs(a.duration - b.duration) <= 2;

      if (sizeMatch && durationMatch) {
        io.to(roomCode).emit('file-status', {
          status: 'matched',
          message: '✓ Files matched! Both ready to watch.'
        });
      } else {
        const reason = [];
        if (!sizeMatch) reason.push(`size differs (${formatBytes(a.size)} vs ${formatBytes(b.size)})`);
        if (!durationMatch) reason.push(`duration differs`);
        io.to(roomCode).emit('file-status', {
          status: 'mismatch',
          message: '✗ Files don\'t match — ' + reason.join(', ')
        });
        room.fileInfo = null;
      }
    }
  });

  // ── SYNC EVENT (world-clock based) ────────────────────────
  // Payload: { roomCode, state, position, timestamp }
  // timestamp = Date.now() on the sender's device (NTP-synced)
  socket.on('sync-event', ({ roomCode, state, position, timestamp }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.state = state;
    room.position = position;
    room.timestamp = timestamp;

    // Broadcast to everyone else in the room
    socket.to(roomCode).emit('sync-event', { state, position, timestamp });
  });

  // ── CHAT ──────────────────────────────────────────────────
  socket.on('chat-message', ({ roomCode, username, message }) => {
    io.to(roomCode).emit('chat-message', { username, message });
  });

  // ── REACTION ──────────────────────────────────────────────
  socket.on('reaction', ({ roomCode, emoji }) => {
    socket.to(roomCode).emit('reaction', { emoji });
  });

  // ── WebRTC SIGNALING ──────────────────────────────────────
  socket.on('webrtc-offer', ({ roomCode, offer }) => {
    socket.to(roomCode).emit('webrtc-offer', { offer, from: socket.id });
  });

  socket.on('webrtc-answer', ({ roomCode, answer, to }) => {
    io.to(to).emit('webrtc-answer', { answer });
  });

  socket.on('webrtc-ice', ({ roomCode, candidate }) => {
    socket.to(roomCode).emit('webrtc-ice', { candidate });
  });

  // ── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.users = room.users.filter(u => u.id !== socket.id);
    io.to(currentRoom).emit('user-count', room.users.length);
    socket.to(currentRoom).emit('peer-left', { username: currentUser });
    console.log(`[${currentRoom}] ${currentUser} left (${room.users.length} remaining)`);
    if (room.users.length === 0) {
      delete rooms[currentRoom];
    }
  });
});

function formatBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + 'GB';
  return (b / 1e6).toFixed(0) + 'MB';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SyncWatch running on http://localhost:${PORT}`);
});
