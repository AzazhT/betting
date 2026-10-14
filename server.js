const express = require('express');
const http = require('http');
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

// ከ PostgreSQL ጋር የሚደረግ ግንኙነት
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// የ Routes ፋይሎችን ማያያዝ
const walletRoutes = require('./routes/wallet')(pool);
const bettingRoutes = require('./routes/betting')(pool);
// የ Bingo ሩትን ከ Socket.io እና Pool ጋር ማያያዝ
const bingoRoutes = require('./routes/bingo')(pool, io);
app.use('/api/bingo', bingoRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/betting', bettingRoutes);

app.get('/', (req, res) => {
  res.send('Ethiopian Multi-Game & Betting Platform Server is running!');
});

// የ Socket.io ግንኙነት (ለሪል-ታይም ጨዋታዎች)
io.on('connection', (socket) => {
  console.log(`ተጫዋች ተገናኝቷል: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`ተጫዋች ወጥቷል: ${socket.id}`);
  });
});

const PORT = Number(process.env.PORT) || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
