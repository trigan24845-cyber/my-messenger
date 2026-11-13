const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY = 200;

// ---------- Хранилище истории ----------
let history = [];
if (fs.existsSync(HISTORY_FILE)) {
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    history = [];
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
  } catch (e) {
    console.error('Ошибка сохранения истории:', e);
  }
}

// ---------- Онлайн-пользователи ----------
const onlineUsers = new Map(); // socket.id -> username

// ---------- Раздача фронтенда ----------
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);

  // Регистрация с ником
  socket.on('join', (username) => {
    username = String(username || '').trim().slice(0, 20);
    if (!username) return;

    // Если ник занят — добавляем цифру
    let finalName = username;
    let counter = 1;
    while ([...onlineUsers.values()].includes(finalName)) {
      finalName = `${username}${counter++}`;
    }

    onlineUsers.set(socket.id, finalName);
    socket.username = finalName;

    // Отправляем новичку историю
    socket.emit('history', history);

    // Всем — обновлённый список онлайн
    io.emit('online', [...onlineUsers.values()]);

    // Системное сообщение
    const sysMsg = {
      type: 'system',
      text: `${finalName} присоединился к чату`,
      time: Date.now()
    };
    io.emit('message', sysMsg);
  });

  // Новое сообщение
  socket.on('message', (text) => {
    if (!socket.username) return;
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return;

    const msg = {
      type: 'user',
      username: socket.username,
      text,
      time: Date.now()
    };

    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    saveHistory();

    io.emit('message', msg);
  });

  // Индикатор «печатает...»
  socket.on('typing', (isTyping) => {
    if (!socket.username) return;
    socket.broadcast.emit('typing', {
      username: socket.username,
      isTyping: !!isTyping
    });
  });

  // Отключение
  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.id);
      io.emit('online', [...onlineUsers.values()]);

      const sysMsg = {
        type: 'system',
        text: `${socket.username} покинул чат`,
        time: Date.now()
      };
      io.emit('message', sysMsg);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});