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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(cors());

// ስታቲክ ፋይሎችን ከ public ፎልደር ማንበቢያ (Frontend UI)
app.use(express.static(path.join(__dirname, 'public')));

// ከ PostgreSQL ጋር የሚደረግ ግንኙነት
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// የ Routes ፋይሎችን ማያያዝ
const walletRoutes = require('./routes/wallet')(pool);
const bettingRoutes = require('./routes/betting')(pool);
const bingoRoutes = require('./routes/bingo')(pool, io);
const kenoRoutes = require('./routes/keno')(pool);
app.use('/api/keno', kenoRoutes);
app.use('/api/bingo', bingoRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/betting', bettingRoutes);

// ዋናው ገጽ (Dashboard) ሲከፈት index.html ን እንዲያሳይ ማድረግ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// የ Socket.io ግንኙነት (ለሪል-ታይም ጨዋታዎች እና ቢንጎ)
io.on('connection', (socket) => {
  console.log(`ተጫዋች ተገናኝቷል: ${socket.id}`);

  // ተጫዋቹ የቢንጎ ሩም ሲቀላቀል
  socket.on('join_bingo_room', (data) => {
    const { room_id, telegram_id } = data;
    socket.join(room_id);
    console.log(`ተጫዋች ${telegram_id} ወደ ክፍሉ ${room_id} ገብቷል`);
    io.to(room_id).emit('player_joined', { telegram_id, message: 'አዲስ ተጫዋች ተቀላቅሏል!' });
  });

  // የቢንጎ ጨዋታ ቁጥሮችን ማውጣት መጀመር
  socket.on('start_game_room', (room_id) => {
    console.log(`የቢንጎ ጨዋታ በክፍል ${room_id} ተጀምሯል!`);
    let calledNumbers = [];
    
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
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
