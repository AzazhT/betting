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

/*
 * ONE-TIME TEST CREDIT
 * Fixed Telegram ID and amount.
 * Requires ADMIN_TEST_KEY in Render Environment.
 */
app.post('/api/admin/test-credit', async (req, res) => {
  const configuredKey = process.env.ADMIN_TEST_KEY;
  const providedKey = req.get('x-admin-test-key') || '';

  if (!configuredKey || !providedKey) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
  }

  const expected = Buffer.from(configuredKey);
  const supplied = Buffer.from(providedKey);

  if (
    expected.length !== supplied.length ||
    !crypto.timingSafeEqual(expected, supplied)
  ) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // A fixed reference prevents this test credit being applied twice.
    const reference = 'test-credit-686733543-v1';

    const previous = await client.query(
      `SELECT id FROM public.transactions
       WHERE reference = $1`,
      [reference]
    );

    if (previous.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'This test credit has already been applied.'
      });
    }

    const userResult = await client.query(
      `SELECT id, telegram_id, name, balance, bonus_balance
       FROM public.users
       WHERE telegram_id = $1
       FOR UPDATE`,
      ['686733543']
    );

    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Telegram user not found.'
      });
    }

    const user = userResult.rows[0];

    const updated = await client.query(
      `UPDATE public.users
       SET balance = balance + 5000.00,
           updated_at = NOW()
       WHERE id = $1
       RETURNING telegram_id, name, balance, bonus_balance`,
      [user.id]
    );

    await client.query(
      `INSERT INTO public.transactions
       (user_id, type, amount, status, reference, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.id,
        'test_credit',
        5000.00,
        'approved',
        reference,
        'One-time administrative test credit'
      ]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Test credit applied successfully.',
      user: updated.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Test credit error:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Test credit failed. Check server logs.'
    });
  } finally {
    client.release();
  }
});

const PORT = Number(process.env.PORT) || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});
