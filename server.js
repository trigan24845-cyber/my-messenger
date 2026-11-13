const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
// Принудительный websocket для скорости (с фолбэком на polling для нестабильных сетей)
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'history.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// --- Папка файлов ---
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

// --- База (в памяти + файл) ---
let rooms = new Map();
let users = new Map(); // { username: { friends: [], avatarColor } }

if (fs.existsSync(HISTORY_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    for (const [roomName, roomData] of Object.entries(data)) {
      rooms.set(roomName, { users: new Map(), history: roomData.history || [], creator: roomData.creator });
    }
  } catch (e) { console.error(e); }
}
if (fs.existsSync(USERS_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    users = new Map(Object.entries(data));
  } catch (e) { console.error(e); }
}

if (!rooms.has('Общий чат')) rooms.set('Общий чат', { users: new Map(), history: [], creator: 'System' });

function saveData() {
  const roomData = {};
  rooms.forEach((r, name) => { roomData[name] = { history: r.history, creator: r.creator }; });
  fs.writeFile(HISTORY_FILE, JSON.stringify(roomData, null, 2), () => {});
  fs.writeFile(USERS_FILE, JSON.stringify(Object.fromEntries(users), null, 2), () => {});
}

function broadcastRooms() {
  const list = [];
  rooms.forEach((r, name) => list.push({ name, count: r.users.size }));
  io.emit('roomList', list);
}

io.on('connection', (socket) => {
  broadcastRooms();

  // --- Вход/Авторизация ---
  socket.on('auth', ({ username, avatarColor }) => {
    socket.username = username;
    socket.avatarColor = avatarColor;
    if (!users.has(username)) users.set(username, { friends: [], avatarColor });
    else users.get(username).avatarColor = avatarColor; // Обновляем цвет
    saveData();
    
    // Отправляем список друзей и приглашений (пока просто заглушка для друзей)
    socket.emit('friendsList', users.get(username).friends || []);
    broadcastRooms();
  });

  // --- Комнаты ---
  socket.on('joinRoom', ({ roomName }) => {
    if (!socket.username) return;
    
    if (socket.roomName && rooms.has(socket.roomName)) {
      const old = rooms.get(socket.roomName);
      old.users.delete(socket.id);
      socket.leave(socket.roomName);
      io.to(socket.roomName).emit('roomUsers', [...old.users.values()]);
      broadcastRooms();
    }

    socket.roomName = roomName;
    if (!rooms.has(roomName)) rooms.set(roomName, { users: new Map(), history: [], creator: socket.username });

    const room = rooms.get(roomName);
    room.users.set(socket.id, { username: socket.username, avatarColor: socket.avatarColor });
    socket.join(roomName);

    socket.emit('history', room.history);
    io.to(roomName).emit('roomUsers', [...room.users.values()]);
    io.to(roomName).emit('message', { type: 'system', text: `${socket.username} присоединился`, time: Date.now() });
    broadcastRooms();
  });

  // --- Сообщения (с мгновенной доставкой) ---
  socket.on('message', (data) => {
    if (!socket.username || !socket.roomName) return;
    const room = rooms.get(socket.roomName);
    if (!room) return;

    const msg = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      type: 'user',
      username: socket.username,
      avatarColor: socket.avatarColor,
      text: data.text || '',
      mediaUrl: data.mediaUrl || null,
      mediaType: data.mediaType || null,
      replyTo: data.replyTo || null,
      time: Date.now(),
      reactions: {},
      edited: false
    };
    
    room.history.push(msg);
    if (room.history.length > 300) room.history.shift();
    saveData();
    
    // Мгновенная рассылка всем в комнате
    io.to(socket.roomName).emit('message', msg);
    socket.emit('messageDelivered', { id: data.tempId });
  });

  // --- Редактирование ---
  socket.on('editMessage', ({ msgId, newText }) => {
    if (!socket.roomName) return;
    const room = rooms.get(socket.roomName);
    if (!room) return;
    const msg = room.history.find(m => m.id === msgId);
    if (msg && msg.username === socket.username) {
      msg.text = newText;
      msg.edited = true;
      saveData();
      io.to(socket.roomName).emit('messageEdited', { msgId, newText, edited: true });
    }
  });

  // --- Удаление ---
  socket.on('deleteMessage', (msgId) => {
    if (!socket.roomName) return;
    const room = rooms.get(socket.roomName);
    if (!room) return;
    const idx = room.history.findIndex(m => m.id === msgId);
    if (idx !== -1 && room.history[idx].username === socket.username) {
      room.history.splice(idx, 1);
      saveData();
      io.to(socket.roomName).emit('messageDeleted', msgId);
    }
  });

  socket.on('deleteRoom', (roomName) => {
    if (!rooms.has(roomName)) return;
    if (rooms.get(roomName).creator !== socket.username) return;
    io.to(roomName).emit('roomDeleted');
    rooms.delete(roomName);
    saveData();
    broadcastRooms();
  });

  // --- Реакции ---
  socket.on('react', ({ messageId, emoji }) => {
    if (!socket.roomName) return;
    const room = rooms.get(socket.roomName);
    if (!room) return;
    const msg = room.history.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const i = msg.reactions[emoji].indexOf(socket.username);
    if (i > -1) {
      msg.reactions[emoji].splice(i, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(socket.username);
    }
    saveData();
    io.to(socket.roomName).emit('updateReactions', { messageId, reactions: msg.reactions });
  });

  // --- Статусы (печатает / записывает) ---
  socket.on('status', ({ type }) => { // type: 'typing', 'recording', 'idle'
    if (!socket.username || !socket.roomName) return;
    socket.to(socket.roomName).emit('userStatus', { username: socket.username, type });
  });

  socket.on('disconnect', () => {
    if (socket.username && socket.roomName) {
      const room = rooms.get(socket.roomName);
      if (room) {
        room.users.delete(socket.id);
        io.to(socket.roomName).emit('roomUsers', [...room.users.values()]);
        io.to(socket.roomName).emit('message', { type: 'system', text: `${socket.username} покинул чат`, time: Date.now() });
        broadcastRooms();
      }
    }
  });
});

server.listen(PORT, () => console.log(`✅ Сервер запущен: http://localhost:${PORT}`));
