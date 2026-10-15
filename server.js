const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const walletRoutes = require('./routes/wallet')(pool);
const bettingRoutes = require('./routes/betting')(pool);
const bingoRoutes = require('./routes/bingo')(pool, io);
const kenoRoutes = require('./routes/keno')(pool, io); // Keno receives Socket.IO.
const aviatorRoutes = require('./routes/aviator')(pool);

app.use('/api/aviator', aviatorRoutes);
app.use('/api/keno', kenoRoutes);
app.use('/api/bingo', bingoRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/betting', bettingRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  console.log(`ተጫዋች ተገናኝቷል: ${socket.id}`);

  socket.on('join_bingo_room', (data = {}) => {
    const { room_id, telegram_id } = data;
    if (!room_id) return;
    socket.join(room_id);
    console.log(`ተጫዋች ${telegram_id || 'unknown'} ወደ ክፍሉ ${room_id} ገብቷል`);
    io.to(room_id).emit('player_joined', {
      telegram_id,
      message: 'አዲስ ተጫዋች ተቀላቅሏል!'
    });
  });

  socket.on('start_game_room', (room_id) => {
    if (!room_id) return;
    console.log(`የቢንጎ ጨዋታ በክፍል ${room_id} ተጀምሯል!`);
    const calledNumbers = [];
    const gameInterval = setInterval(() => {
      if (calledNumbers.length >= 75) {
        clearInterval(gameInterval);
        io.to(room_id).emit('game_over', { message: 'ጨዋታው አልቋል!' });
        return;
      }
      let randomNum;
      do {
        randomNum = Math.floor(Math.random() * 75) + 1;
      } while (calledNumbers.includes(randomNum));
      calledNumbers.push(randomNum);
      io.to(room_id).emit('number_called', {
        number: randomNum,
        called_numbers: calledNumbers
      });
    }, 3000);
  });

  socket.on('disconnect', () => {
    console.log(`ተጫዋች ወጥቷል: ${socket.id}`);
  });
});

const PORT = Number(process.env.PORT) || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});
