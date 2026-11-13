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

// --- Логика Комнат ---
// Структура: rooms = { "Имя комнаты": { users: Map(socketId -> username), history: [] } }
const rooms = new Map();

// Функция для отправки списка комнат всем в лобби
function broadcastRooms() {
  const roomList = [];
  rooms.forEach((room, name) => {
    roomList.push({ name, count: room.users.size });
  });
  io.emit('roomList', roomList);
}

io.on('connection', (socket) => {
  // Отправляем список комнат при подключении
  broadcastRooms();

  socket.on('joinRoom', ({ username, roomName }) => {
    if (!username || !roomName) return;
    
    socket.username = username;
    socket.roomName = roomName;

    if (!rooms.has(roomName)) {
      rooms.set(roomName, { users: new Map(), history: [] });
    }

    const room = rooms.get(roomName);
    room.users.set(socket.id, username);
    socket.join(roomName);

    // Отправляем историю сообщений этой комнаты
    socket.emit('history', room.history);
    
    // Обновляем список пользователей в комнате
    io.to(roomName).emit('roomUsers', [...room.users.values()]);
    
    // Системное сообщение
    io.to(roomName).emit('message', { type: 'system', text: `${username} присоединился`, time: Date.now() });
    
    // Обновляем общий список комнат (количество людей)
    broadcastRooms();
  });

  socket.on('message', (data) => {
    if (!socket.username || !socket.roomName) return;
    const room = rooms.get(socket.roomName);
    if (!room) return;

    const msg = {
      type: 'user',
      username: socket.username,
      text: data.text || '',
      audioUrl: data.audioUrl || null,
      time: Date.now()
    };
    
    room.history.push(msg);
    if (room.history.length > 200) room.history.shift();
    
    // Отправляем только в эту комнату
    io.to(socket.roomName).emit('message', msg);
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
        
        // Если комната пуста — можно удалить (по желанию)
        // if (room.users.size === 0) rooms.delete(socket.roomName);
        
        broadcastRooms();
      }
    }
  });
});

server.listen(PORT, () => console.log(`✅ Сервер запущен: http://localhost:${PORT}`));
