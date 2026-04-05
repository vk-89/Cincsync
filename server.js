const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Room Storage ────────────────────────────────────────────────
// rooms[code] = { users: [socketId, socketId], fileInfo: { name, size } per user }
const rooms = {};

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusable chars
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─── Master Clock ─────────────────────────────────────────────────
// Every second, broadcast server timestamp to all rooms so both clients
// can sync video position to absolute wall-clock time
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    io.to(code).emit("server-clock", { serverTime: now });
  }
}, 1000);

// ─── Socket Events ────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // ── CREATE ROOM ──────────────────────────────────────────────────
  socket.on("create-room", () => {
    let code;
    // Make sure code is unique
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      users: [socket.id],
      fileInfo: {},
      syncState: { playing: false, position: 0, updatedAt: Date.now() }
    };

    socket.join(code);
    socket.roomCode = code;
    console.log(`Room created: ${code} by ${socket.id}`);

    socket.emit("room-created", { code });
  });

  // ── JOIN ROOM ────────────────────────────────────────────────────
  socket.on("join-room", ({ code }) => {
    const room = rooms[code];

    if (!room) {
      socket.emit("join-error", { message: "Room not found. Check the code." });
      return;
    }
    if (room.users.length >= 2) {
      socket.emit("join-error", { message: "Room is full. Only 2 people allowed." });
      return;
    }

    room.users.push(socket.id);
    socket.join(code);
    socket.roomCode = code;
    console.log(`${socket.id} joined room ${code}`);

    // Tell the joiner current sync state
    socket.emit("room-joined", {
      code,
      syncState: room.syncState
    });

    // Tell the creator that partner joined
    socket.to(code).emit("partner-joined");
  });

  // ── FILE INFO (for matching check) ───────────────────────────────
  socket.on("file-info", ({ name, size }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    rooms[code].fileInfo[socket.id] = { name, size };
    const infos = Object.values(rooms[code].fileInfo);

    // Only check when both users have submitted file info
    if (infos.length === 2) {
      const match = infos[0].size === infos[1].size;
      io.to(code).emit("file-match-result", {
        match,
        files: infos.map(f => f.name)
      });
    }
  });

  // ── SYNC PLAY ─────────────────────────────────────────────────────
  socket.on("sync-play", ({ position }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    rooms[code].syncState = { playing: true, position, updatedAt: Date.now() };
    // Tell partner to play at this position
    socket.to(code).emit("remote-play", { position, serverTime: Date.now() });
  });

  // ── SYNC PAUSE ────────────────────────────────────────────────────
  socket.on("sync-pause", ({ position }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    rooms[code].syncState = { playing: false, position, updatedAt: Date.now() };
    socket.to(code).emit("remote-pause", { position });
  });

  // ── SYNC SEEK ─────────────────────────────────────────────────────
  socket.on("sync-seek", ({ position }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    rooms[code].syncState.position = position;
    rooms[code].syncState.updatedAt = Date.now();
    socket.to(code).emit("remote-seek", { position });
  });

  // ── RESYNC REQUEST ────────────────────────────────────────────────
  socket.on("request-resync", () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    const state = rooms[code].syncState;
    socket.emit("resync-state", {
      ...state,
      serverTime: Date.now()
    });
  });

  // ── EMOJI REACTION ────────────────────────────────────────────────
  socket.on("emoji-reaction", ({ emoji }) => {
    const code = socket.roomCode;
    if (!code) return;
    socket.to(code).emit("remote-emoji", { emoji });
  });

  // ── WEBRTC SIGNALING ──────────────────────────────────────────────
  // Audio is now carried inside WebRTC alongside video.
  // The server only relays signaling messages — no media data passes through.
  socket.on("webrtc-offer", ({ offer }) => {
    socket.to(socket.roomCode).emit("webrtc-offer", { offer });
  });

  socket.on("webrtc-answer", ({ answer }) => {
    socket.to(socket.roomCode).emit("webrtc-answer", { answer });
  });

  socket.on("webrtc-ice", ({ candidate }) => {
    socket.to(socket.roomCode).emit("webrtc-ice", { candidate });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    console.log(`${socket.id} disconnected from room ${code}`);
    rooms[code].users = rooms[code].users.filter(id => id !== socket.id);
    delete rooms[code].fileInfo[socket.id];

    // Notify partner
    socket.to(code).emit("partner-left");

    // Clean up empty rooms
    if (rooms[code].users.length === 0) {
      delete rooms[code];
      console.log(`Room ${code} deleted`);
    }
  });
});

// ─── Start Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CincSync server running on port ${PORT}`);
});
