const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);

// Настройка CORS и транспорта (polling для обхода блокировок)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['polling', 'websocket'] 
});

const PORT = process.env.PORT || 3000;

// --- Настройка папки для голосовых сообщений ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '.webm');
  }
});
const upload = multer({ storage: storage });

// --- Раздача статики ---
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// Эндпоинт для получения аудио с клиента
app.post('/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Логика Socket.io ---
let history = [];
const onlineUsers = new Map();

io.on('connection', (socket) => {
  socket.on('join', (username) => {
    username = String(username || '').trim().slice(0, 20);
    if (!username) return;
    
    // Сохраняем ник ровно таким, каким его ввели
    onlineUsers.set(socket.id, username);
    socket.username = username;
    
    socket.emit('history', history);
    io.emit('online', [...onlineUsers.values()]);
    io.emit('message', { type: 'system', text: `${username} присоединился`, time: Date.now() });
  });

  socket.on('message', (data) => {
    if (!socket.username) return;
    const msg = {
      type: 'user',
      username: socket.username,
      text: data.text || '',
      audioUrl: data.audioUrl || null,
      time: Date.now()
    };
    history.push(msg);
    if (history.length > 200) history.shift();
    io.emit('message', msg);
  });

  socket.on('typing', (isTyping) => {
    if (!socket.username) return;
    socket.broadcast.emit('typing', { username: socket.username, isTyping: !!isTyping });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.id);
      io.emit('online', [...onlineUsers.values()]);
      io.emit('message', { type: 'system', text: `${socket.username} покинул чат`, time: Date.now() });
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});
