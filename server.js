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
            { text: '🎮 Open App', url: 'https://example.com' }
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
    if (!bot) return;
    try {
      await bot.sendMessage(ADMIN_ID, message, {
        reply_markup: keyboard
      });
    } catch (err) {
      console.error('Admin notification send error:', err.message);
    }
  }
});

const bettingRoutes = require('./routes/betting')(pool);
const bingoRoutes = require('./routes/bingo')(pool, io);
const kenoRoutes = require('./routes/keno')(pool, io);
const aviatorRoutes = require('./routes/aviator')(pool);

app.use('/api/aviator', aviatorRoutes);
app.use('/api/keno', kenoRoutes);
app.use('/api/bingo', bingoRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/betting', bettingRoutes);

// ... ቀሪው የserver.js ኮድ እንዳለ ይቀጥላል ...
