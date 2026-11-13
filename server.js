const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'history.json');
const USERS_FILE = path.join(__dirname, 'users.json');

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
  }
});
const upload = multer({ storage });

app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const type = req.file.mimetype.startsWith('image/') ? 'image' : 'audio';
  res.json({ url: `/uploads/${req.file.filename}`, type });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let rooms = new Map();
let users = new Map();
let privateChats = new Map();

if (fs.existsSync(HISTORY_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    for (const [roomName, roomData] of Object.entries(data.rooms || {})) {
      rooms.set(roomName, { users: new Map(), history: roomData.history || [], creator: roomData.creator, password: roomData.password || null });
    }
    if (data.users) users = new Map(Object.entries(data.users));
    if (data.privateChats) privateChats = new Map(Object.entries(data.privateChats));
  } catch (e) { console.error(e); }
}

if (!rooms.has('Общий чат')) rooms.set('Общий чат', { users: new Map(), history: [], creator: 'System', password: null });

function saveData() {
  const roomData = {};
  rooms.forEach((r, name) => { roomData[name] = { history: r.history, creator: r.creator, password: r.password }; });
  fs.writeFile(HISTORY_FILE, JSON.stringify({ rooms: roomData, users: Object.fromEntries(users), privateChats: Object.fromEntries(privateChats) }, null, 2), () => {});
}

function broadcastRooms() {
  const list = [];
  rooms.forEach((r, name) => list.push({ name, count: r.users.size, hasPassword: !!r.password }));
  io.emit('roomList', list);
}

function getPrivateChatKey(u1, u2) { return [u1, u2].sort().join('|'); }

io.on('connection', (socket) => {
  broadcastRooms();

  socket.on('auth', ({ username, avatarColor }) => {
    socket.username = username;
    socket.avatarColor = avatarColor;
    if (!users.has(username)) users.set(username, { friends: [], avatarColor });
    else users.get(username).avatarColor = avatarColor;
    saveData();
    socket.emit('friendsList', users.get(username).friends || []);
    broadcastRooms();
  });

  socket.on('joinRoom', ({ roomName, password }) => {
    if (!socket.username || !rooms.has(roomName)) return;
    const room = rooms.get(roomName);
    if (room.password && room.password !== password && room.creator !== socket.username) {
      return socket.emit('roomError', 'Неверный пароль');
    }

    if (socket.roomName && rooms.has(socket.roomName)) {
      const old = rooms.get(socket.roomName);
      old.users.delete(socket.id);
      socket.leave(socket.roomName);
      io.to(socket.roomName).emit('roomUsers', [...old.users.values()]);
      broadcastRooms();
    }

    socket.roomName = roomName;
    socket.currentPrivate = null;
    room.users.set(socket.id, { username: socket.username, avatarColor: socket.avatarColor });
    socket.join(roomName);

    socket.emit('history', { type: 'room', history: room.history });
    io.to(roomName).emit('roomUsers', [...room.users.values()]);
    broadcastRooms();
  });

  socket.on('createRoom', ({ name, password }) => {
    if (!socket.username) return;
    if (rooms.has(name)) return socket.emit('roomError', 'Комната уже существует');
    rooms.set(name, { users: new Map(), history: [], creator: socket.username, password: password || null });
    saveData(); broadcastRooms();
  });

  socket.on('deleteRoom', (roomName) => {
    if (!rooms.has(roomName) || rooms.get(roomName).creator !== socket.username) return;
    io.to(roomName).emit('roomDeleted');
    rooms.delete(roomName);
    saveData(); broadcastRooms();
  });

  socket.on('clearHistory', (roomName) => {
    if (!rooms.has(roomName) || rooms.get(roomName).creator !== socket.username) return;
    rooms.get(roomName).history = [];
    saveData(); io.to(roomName).emit('historyCleared');
  });

  socket.on('openPrivate', (friendName) => {
    if (!socket.username) return;
    const key = getPrivateChatKey(socket.username, friendName);
    if (!privateChats.has(key)) privateChats.set(key, { history: [] });
    if (socket.currentPrivate) socket.leave(socket.currentPrivate);
    socket.join(key);
    socket.currentPrivate = key;
    socket.emit('history', { type: 'private', history: privateChats.get(key).history, peer: friendName });
  });

  socket.on('sendPrivate', ({ to, text, mediaUrl, mediaType, replyTo, tempId }) => {
    if (!socket.username) return;
    const key = getPrivateChatKey(socket.username, to);
    if (!privateChats.has(key)) privateChats.set(key, { history: [] });
    const chat = privateChats.get(key);
    const msg = { id: Date.now() + Math.random().toString(36).substr(2, 9), username: socket.username, avatarColor: socket.avatarColor, text: text || '', mediaUrl, mediaType, replyTo, time: Date.now(), reactions: {}, edited: false };
    chat.history.push(msg); saveData();
    io.to(key).emit('privateMessage', { msg, to, from: socket.username });
    socket.emit('messageDelivered', { id: tempId });
  });

  socket.on('message', (data) => {
    if (!socket.username || !socket.roomName) return;
    const room = rooms.get(socket.roomName);
    if (!room) return;
    const msg = { id: Date.now() + Math.random().toString(36).substr(2, 9), type: 'user', username: socket.username, avatarColor: socket.avatarColor, text: data.text || '', mediaUrl: data.mediaUrl || null, mediaType: data.mediaType || null, replyTo: data.replyTo || null, time: Date.now(), reactions: {}, edited: false };
    room.history.push(msg); if (room.history.length > 300) room.history.shift(); saveData();
    io.to(socket.roomName).emit('message', msg);
    socket.emit('messageDelivered', { id: data.tempId });
  });

  socket.on('editMessage', ({ msgId, newText, isPrivate }) => {
    let history = isPrivate ? (socket.currentPrivate ? privateChats.get(socket.currentPrivate).history : null) : (socket.roomName ? rooms.get(socket.roomName).history : null);
    if (!history) return;
    const msg = history.find(m => m.id === msgId);
    if (msg && msg.username === socket.username) {
      msg.text = newText; msg.edited = true; saveData();
      io.to(isPrivate ? socket.currentPrivate : socket.roomName).emit('messageEdited', { msgId, newText });
    }
  });

  socket.on('deleteMessage', ({ msgId, isPrivate }) => {
    let history = isPrivate ? (socket.currentPrivate ? privateChats.get(socket.currentPrivate).history : null) : (socket.roomName ? rooms.get(socket.roomName).history : null);
    let target = isPrivate ? socket.currentPrivate : socket.roomName;
    if (!history) return;
    const idx = history.findIndex(m => m.id === msgId);
    if (idx !== -1 && history[idx].username === socket.username) {
      history.splice(idx, 1); saveData(); io.to(target).emit('messageDeleted', msgId);
    }
  });

  socket.on('react', ({ messageId, emoji, isPrivate }) => {
    let history = isPrivate ? (socket.currentPrivate ? privateChats.get(socket.currentPrivate).history : null) : (socket.roomName ? rooms.get(socket.roomName).history : null);
    let target = isPrivate ? socket.currentPrivate : socket.roomName;
    if (!history) return;
    const msg = history.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const i = msg.reactions[emoji].indexOf(socket.username);
    if (i > -1) { msg.reactions[emoji].splice(i, 1); if (!msg.reactions[emoji].length) delete msg.reactions[emoji]; }
    else msg.reactions[emoji].push(socket.username);
    saveData(); io.to(target).emit('updateReactions', { messageId, reactions: msg.reactions });
  });

  socket.on('addFriend', (friendName) => {
    if (!socket.username || !users.has(socket.username)) return;
    const user = users.get(socket.username);
    if (!user.friends) user.friends = [];
    if (friendName !== socket.username && !user.friends.includes(friendName)) {
      user.friends.push(friendName); saveData(); socket.emit('friendsList', user.friends);
    }
  });

  socket.on('status', ({ type }) => {
    if (!socket.username) return;
    if (socket.roomName) socket.to(socket.roomName).emit('userStatus', { username: socket.username, type });
    if (socket.currentPrivate) socket.to(socket.currentPrivate).emit('userStatus', { username: socket.username, type });
  });

  socket.on('disconnect', () => {
    if (socket.username && socket.roomName && rooms.has(socket.roomName)) {
      const room = rooms.get(socket.roomName);
      room.users.delete(socket.id);
      io.to(socket.roomName).emit('roomUsers', [...room.users.values()]);
      broadcastRooms();
    }
  });
});

server.listen(PORT, () => console.log(`✅ Сервер запущен: http://localhost:${PORT}`));
