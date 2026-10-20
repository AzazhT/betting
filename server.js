const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '686733543');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;

let bot = null;

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    const keyboard = WEB_APP_URL
      ? {
          inline_keyboard: [[
            { text: '🎮 Open App', web_app: { url: WEB_APP_URL } }
          ]]
        }
      : {
          inline_keyboard: [[
            { text: '🎮 Open App', url: 'https://betting-1-wsrp.onrender.com' }
          ]]
        };

    try {
      await bot.sendMessage(
        chatId,
        'እንኳን ወደ Ethiopia Games በደህና መጡ! 🎮\n\nOpen App በመጫን ጨዋታውን ይክፈቱ።',
        { reply_markup: keyboard }
      );
    } catch (err) {
      console.error('Telegram start error:', err.message);
    }
  });

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err.message);
  });
} else {
  console.error('TELEGRAM_BOT_TOKEN is missing');
}

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

// Wallet routes initialized with notifyAdmin callback
const walletRoutes = require('./routes/wallet')(pool, {
  notifyAdmin: async (message, keyboard) => {
    if (!bot) {
      throw new Error('Telegram bot is not initialized');
    }

    await bot.sendMessage(
      String(process.env.ADMIN_TELEGRAM_ID || '686733543'),
      message,
      { reply_markup: keyboard, parse_mode: 'HTML' }
    );
  }
});

const bettingRoutes = require('./routes/betting')(pool);
const bingoRoutes = require('./routes/bingo')(pool, io);
const kenoRoutes = require('./routes/keno')(pool, io);
const aviatorRoutes = require('./routes/aviator')(pool);

const lotteryRoutes = require('./routes/lottery')(pool, {
  notifyAdmin: async (message) => {
    if (!bot) {
      throw new Error('Telegram bot is not initialized');
    }

    await bot.sendMessage(ADMIN_ID, message, {
      parse_mode: 'HTML'
    });
  },

  notifyBuyer: async (telegramId, message) => {
    if (!bot) {
      throw new Error('Telegram bot is not initialized');
    }

    console.log('Sending lottery receipt to Telegram ID:', telegramId);

    await bot.sendMessage(String(telegramId), message, {
      parse_mode: 'HTML'
    });

    console.log('Lottery receipt sent successfully to:', telegramId);
  }
});


app.use('/api/aviator', aviatorRoutes);
app.use('/api/lottery', lotteryRoutes);
app.use('/api/keno', kenoRoutes);
app.use('/api/bingo', bingoRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/betting', bettingRoutes);

// --- BINGO SHARED WALLET API ---
app.post('/api/place-bet', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim();
  const amount = Number(req.body?.amount);
  if (!identifier || !Number.isFinite(amount) || amount <= 0 || amount > 10000) {
    return res.status(400).json({ success: false, message: 'Invalid player or bet amount.' });
  }
  try {
    const result = await pool.query(
      `UPDATE public.users SET balance = balance - $1, updated_at = NOW()
       WHERE telegram_id = $2 AND balance >= $1
       RETURNING balance`, [amount, identifier]
    );
    if (!result.rowCount) {
      const user = await pool.query('SELECT id FROM public.users WHERE telegram_id = $1', [identifier]);
      return res.status(user.rowCount ? 400 : 404).json({ success: false, message: user.rowCount ? 'Insufficient wallet balance.' : 'User not found. Open wallet first.' });
    }
    return res.json({ success: true, newBalance: Number(result.rows[0].balance) });
  } catch (err) {
    console.error('Bingo place-bet error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not place bet.' });
  }
});
// --- END BINGO SHARED WALLET API ---

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

/* --- TELEGRAM ADMIN APPROVE / REJECT --- */
if (bot) {
  bot.on('callback_query', async (query) => {
    // Telegram የሚሽከረከረው ምልክት እንዲቆም ወዲያውኑ መልስ
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'ጥያቄዎ ተቀብሏል። እየተሰራ ነው...'
      });
    } catch (err) {
      console.error('Callback acknowledgement error:', err.message);
    }

    const adminId = String(
      process.env.ADMIN_TELEGRAM_ID || '686733543'
    );

    if (String(query.from.id) !== adminId) {
      console.warn('Unauthorized wallet callback:', query.from.id);
      return;
    }

    const match = /^wallet:(approve|reject):(\d+)$/.exec(
      query.data || ''
    );

    if (!match) {
      console.warn('Unknown Telegram callback:', query.data);
      return;
    }

    const action = match[1];
    const requestId = match[2];
    const port = Number(process.env.PORT) || 10000;

    try {
      if (!ADMIN_API_TOKEN) {
        throw new Error('ADMIN_API_TOKEN is missing');
      }

      const response = await fetch(
        `http://127.0.0.1:${port}/api/wallet/admin/requests/${requestId}/review`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ADMIN_API_TOKEN}`
          },
          body: JSON.stringify({ action }),
          signal: AbortSignal.timeout(15000)
        }
      );

      const raw = await response.text();
      let result;

      try {
        result = JSON.parse(raw);
      } catch {
        result = { message: raw || 'Invalid API response' };
      }

      if (!response.ok || !result.success) {
        const reason =
          result.error ||
          result.message ||
          `HTTP ${response.status}`;

        console.error('Wallet review failed:', {
          requestId,
          action,
          status: response.status,
          reason
        });

        await bot.sendMessage(
          adminId,
          `⚠️ Wallet request ${requestId} ማስኬድ አልተሳካም።\nምክንያት: ${String(reason).slice(0, 700)}`
        );
        return;
      }

      const statusText = action === 'approve'
        ? '✅ APPROVED'
        : '❌ REJECTED';

      if (query.message) {
        const oldText = query.message.text || 'Wallet request';

        await bot.editMessageText(
          `${oldText}\n\n${statusText}\nRequest ID: ${requestId}`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        ).catch(async (err) => {
          console.error('Could not update Telegram message:', err.message);

          await bot.sendMessage(
            adminId,
            `${statusText}\nRequest ID: ${requestId}`
          );
        });
      }

      console.log(
        `Wallet request ${requestId}: ${action} successful`
      );
    } catch (err) {
      console.error('Wallet callback error:', err.message);

      await bot.sendMessage(
        adminId,
        `⚠️ የWallet ጥያቄ ${requestId} ላይ ስህተት ተፈጥሯል።\n${String(err.message).slice(0, 700)}`
      ).catch((sendErr) => {
        console.error('Could not notify admin:', sendErr.message);
      });
    }
  });
}
/* --- END TELEGRAM ADMIN APPROVE / REJECT --- */

/*
 * ONE-TIME TEST CREDIT
 */
app.post('/api/admin/test-credit', async (req, res) => {
  const configuredKey = process.env.ADMIN_TEST_KEY;
  const providedKey = req.get('x-admin-test-key') || '';

  if (!configuredKey || !providedKey) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const expected = Buffer.from(configuredKey);
  const supplied = Buffer.from(providedKey);

  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reference = 'test-credit-686733543-v1';
    const previous = await client.query(`SELECT id FROM public.transactions WHERE reference = $1`, [reference]);

    if (previous.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'This test credit has already been applied.' });
    }

    const userResult = await client.query(
      `SELECT id, telegram_id, name, balance, bonus_balance FROM public.users WHERE telegram_id = $1 FOR UPDATE`,
      ['686733543']
    );

    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Telegram user not found.' });
    }

    const user = userResult.rows[0];
    const updated = await client.query(
      `UPDATE public.users SET balance = balance + 5000.00, updated_at = NOW() WHERE id = $1 RETURNING telegram_id, name, balance, bonus_balance`,
      [user.id]
    );

    await client.query(
      `INSERT INTO public.transactions (user_id, type, amount, status, reference, description) VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, 'test_credit', 5000.00, 'approved', reference, 'One-time administrative test credit']
    );

    await client.query('COMMIT');
    return res.json({ success: true, message: 'Test credit applied successfully.', user: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Test credit error:', err.message);
    return res.status(500).json({ success: false, message: 'Test credit failed. Check server logs.' });
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
