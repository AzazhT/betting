const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Socket.io setup with production-ready CORS (Adjust origin in production)
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS || "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Database Connection Test
pool.query('SELECT 1', (err) => {
  if (err) {
    console.error('Database connection error:', err.stack);
    process.exit(1);
  } else {
    console.log('Connected to PostgreSQL successfully.');
  }
});

// In-memory state for Bingo rooms to prevent duplicate intervals
const bingoRooms = new Map();

/**
 * Helper: Securely shuffle an array
 */
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Routes - Injecting pool and io
const walletRoutes = require('./routes/wallet')(pool);
const bettingRoutes = require('./routes/betting')(pool);
const bingoRoutes = require('./routes/bingo')(pool, io);
// Pass IO to Keno to enable real-time draw notifications
const kenoRoutes = require('./routes/keno')(pool, io);

app.use('/api/keno', kenoRoutes);
app.use('/api/bingo', bingoRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/betting', bettingRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io Connection Logic
io.on('connection', (socket) => {
  console.log(`ተጫዋች ተገናኝቷል: ${socket.id}`);

  // Join Bingo Room
  socket.on('join_bingo_room', (data) => {
    const { room_id, telegram_id } = data;
    if (!room_id || !telegram_id) return;

    socket.join(room_id);
    console.log(`ተጫዋች ${telegram_id} ወደ ክፍሉ ${room_id} ገብቷል`);
    
    // Broadcast to room (excluding sender)
    socket.to(room_id).emit('player_joined', { 
      telegram_id, 
      message: 'አዲስ ተጫዋች ተቀላቅሏል!' 
    });
  });

  // Start Bingo Game (Improved logic)
  socket.on('start_game_room', (room_id) => {
    // Prevent multiple intervals for the same room
    if (bingoRooms.has(room_id)) {
      console.log(`Game already running in room: ${room_id}`);
      return;
    }

    console.log(`የቢንጎ ጨዋታ በክፍል ${room_id} ተጀምሯል!`);
    
    // Generate a shuffled deck of 75 numbers
    const deck = shuffleArray(Array.from({ length: 75 }, (_, i) => i + 1));
    const calledNumbers = [];
    
    const gameInterval = setInterval(() => {
      if (deck.length === 0) {
        clearInterval(gameInterval);
        bingoRooms.delete(room_id);
        io.to(room_id).emit('game_over', { message: 'ጨዋታው አልቋል!' });
        return;
      }

      const nextNum = deck.pop();
      calledNumbers.push(nextNum);

      io.to(room_id).emit('number_called', {
        number: nextNum,
        called_numbers: calledNumbers
      });
    }, 3000);

    bingoRooms.set(room_id, gameInterval);
  });

  socket.on('disconnect', () => {
    console.log(`ተጫዋች ወጥቷል: ${socket.id}`);
  });
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    pool.end(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});

const PORT = Number(process.env.PORT) || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
