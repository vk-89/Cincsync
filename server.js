const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// rooms[code] = { state, position, timestamp, fileInfos:{socketId->info}, users:[{id,username}] }
const rooms = {};

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      state: 'paused', position: 0, timestamp: Date.now(),
      fileInfos: {}, users: []
    };
  }
  return rooms[code];
}

// Check if all users in the room have submitted matching file info
function checkFileMatch(room) {
  const infos = Object.values(room.fileInfos);
  if (infos.length < room.users.length) return null; // not everyone picked yet
  if (infos.length < 2) return null; // need at least 2

  const first = infos[0];
  const allMatch = infos.every(fi =>
    fi.size === first.size && Math.abs(fi.duration - first.duration) <= 2
  );
  if (allMatch) return { ok: true };

  // Find mismatches to report
  const sizes = [...new Set(infos.map(f => formatBytes(f.size)))];
  return { ok: false, reason: `sizes: ${sizes.join(' vs ')}` };
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

    socket.emit('room-state', {
      state: room.state, position: room.position,
      timestamp: room.timestamp, userCount: room.users.length
    });

    // Tell others this person joined (include socketId for WebRTC mesh)
    socket.to(roomCode).emit('peer-joined', { username, socketId: socket.id });
    io.to(roomCode).emit('user-count', room.users.length);

    // Send this user the existing file infos so they can see peers' files
    for (const [sid, fi] of Object.entries(room.fileInfos)) {
      if (sid !== socket.id) {
        socket.emit('peer-file-info', { fileInfo: fi });
      }
    }

    console.log(`[${roomCode}] ${username} joined (${room.users.length} total)`);
  });

  // ── REQUEST PEER IDS (for WebRTC mesh when starting a call) ──
  socket.on('request-peer-ids', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const ids = room.users.filter(u => u.id !== socket.id).map(u => u.id);
    socket.emit('peer-ids', { ids });
  });

  // ── FILE INFO ─────────────────────────────────────────────
  socket.on('file-info', ({ roomCode, fileInfo }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.fileInfos[socket.id] = fileInfo;

    // Broadcast to all others so they see this user's file thumbnail
    socket.to(roomCode).emit('peer-file-info', { fileInfo });

    const allCount = room.users.length;
    const pickedCount = Object.keys(room.fileInfos).length;

    if (pickedCount < allCount) {
      // Not everyone has picked yet
      socket.emit('file-status', {
        status: 'waiting',
        message: `Waiting for ${allCount - pickedCount} more friend(s) to select their file…`
      });
    } else {
      // Everyone picked — check match
      const result = checkFileMatch(room);
      if (result && result.ok) {
        io.to(roomCode).emit('file-status', {
          status: 'matched',
          message: `✓ All ${allCount} files matched! Ready to watch.`
        });
      } else if (result && !result.ok) {
        io.to(roomCode).emit('file-status', {
          status: 'mismatch',
          message: `✗ Files don't match — ${result.reason}`
        });
        // Reset so they can try again
        room.fileInfos = {};
      }
    }
  });

  // ── SYNC EVENT ────────────────────────────────────────────
  socket.on('sync-event', ({ roomCode, state, position, timestamp }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.state = state; room.position = position; room.timestamp = timestamp;
    socket.to(roomCode).emit('sync-event', { state, position, timestamp });
  });

  // ── REACTION ──────────────────────────────────────────────
  socket.on('reaction', ({ roomCode, emoji }) => {
    socket.to(roomCode).emit('reaction', { emoji });
  });

  // ── WebRTC SIGNALING (targeted by socketId) ───────────────
  socket.on('webrtc-offer', ({ roomCode, offer, to }) => {
    io.to(to).emit('webrtc-offer', { offer, from: socket.id });
  });
  socket.on('webrtc-answer', ({ roomCode, answer, to }) => {
    io.to(to).emit('webrtc-answer', { answer, from: socket.id });
  });
  socket.on('webrtc-ice', ({ roomCode, candidate, to }) => {
    io.to(to).emit('webrtc-ice', { candidate, from: socket.id });
  });

  // ── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.users = room.users.filter(u => u.id !== socket.id);
    delete room.fileInfos[socket.id];
    io.to(currentRoom).emit('user-count', room.users.length);
    socket.to(currentRoom).emit('peer-left', { username: currentUser, socketId: socket.id });
    console.log(`[${currentRoom}] ${currentUser} left (${room.users.length} remaining)`);
    if (room.users.length === 0) delete rooms[currentRoom];
  });
});

function formatBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + 'GB';
  return (b / 1e6).toFixed(0) + 'MB';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncWatch running on http://localhost:${PORT}`));
