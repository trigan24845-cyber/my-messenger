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
  transports: ['polling', 'websocket'] 
});

const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'history.json');

// --- Настройка папки для голосовых ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '.webm');
  }
});
const upload = multer({ storage });

app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- Работа с историей ---
let rooms = new Map();

// Загрузка истории из файла (если есть)
if (fs.existsSync(HISTORY_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    for (const [roomName, roomData] of Object.entries(data)) {
      rooms.set(roomName, {
        users: new Map(),
        history: roomData.history || []
      });
    }
  } catch (e) {
    console.error("Ошибка чтения истории:", e);
  }
}

if (!rooms.has('Общий чат')) {
  rooms.set('Общий чат', { users: new Map(), history: [] });
}

function saveHistory() {
  const data = {};
  for (const [roomName, roomData] of rooms.entries()) {
    data[roomName] = { history: roomData.history };
  }
  fs.writeFile(HISTORY_FILE, JSON.stringify(data, null, 2), (err) => {
    if (err) console.error("Ошибка сохранения истории:", err);
  });
}

function broadcastRooms() {
  const roomList = [];
  rooms.forEach((room, name) => {
    roomList.push({ name, count: room.users.size });
  });
  io.emit('roomList', roomList);
}

io.on('connection', (socket) => {
  broadcastRooms();

  socket.on('joinRoom', ({ username, roomName }) => {
    if (!username || !roomName) return;
    
    if (socket.roomName && rooms.has(socket.roomName)) {
      const oldRoom = rooms.get(socket.roomName);
      oldRoom.users.delete(socket.id);
      socket.leave(socket.roomName);
      io.to(socket.roomName).emit('roomUsers', [...oldRoom.users.values()]);
      broadcastRooms();
    }

    socket.username = username;
    socket.roomName = roomName;

    if (!rooms.has(roomName)) {
      rooms.set(roomName, { users: new Map(), history: [] });
    }

    const room = rooms.get(roomName);
    room.users.set(socket.id, username);
    socket.join(roomName);

    socket.emit('history', room.history);
    io.to(roomName).emit('roomUsers', [...room.users.values()]);
    io.to(roomName).emit('message', { type: 'system', text: `${username} присоединился`, time: Date.now() });
    
    broadcastRooms();
  });

  // Обработка нового сообщения (с подтверждением)
  socket.on('message', (data) => {
    if (!socket.username || !socket.roomName) return;
    const room = rooms.get(socket.roomName);
    if (!room) return;

    const msg = {
      id: Date.now() + Math.random().toString(36).substr(2, 9), // Уникальный ID
      type: 'user',
      username: socket.username,
      text: data.text || '',
      audioUrl: data.audioUrl || null,
      replyTo: data.replyTo || null,
      time: Date.now(),
      reactions: {} // { "❤️": ["User1", "User2"] }
    };
    
    room.history.push(msg);
    if (room.history.length > 300) room.history.shift(); // Храним 300 последних
    saveHistory();
    
    // Отправляем всем в комнате, и отдельно подтверждаем отправителю
    io.to(socket.roomName).emit('message', msg);
    socket.emit('messageDelivered', { id: data.tempId });
  });

  // Обработка реакций
  socket.on('react', ({ messageId, emoji }) => {
    if (!socket.roomName) return;
    const room = rooms.get(socket.roomName);
    if (!room) return;

    const msg = room.history.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    
    const index = msg.reactions[emoji].indexOf(socket.username);
    if (index > -1) {
      msg.reactions[emoji].splice(index, 1); // Убираем реакцию
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(socket.username); // Добавляем реакцию
    }

    saveHistory();
    io.to(socket.roomName).emit('updateReactions', { messageId, reactions: msg.reactions });
  });

  socket.on('typing', (isTyping) => {
    if (!socket.username || !socket.roomName) return;
    socket.to(socket.roomName).emit('typing', { username: socket.username, isTyping: !!isTyping });
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
