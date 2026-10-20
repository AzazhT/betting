'use strict';
const express = require('express');
const crypto = require('crypto');

module.exports = function createLotteryRouter(pool, options = {}) {
  const router = express.Router();
  const notifyAdmin = options.notifyAdmin;
  const notifyBuyer = options.notifyBuyer;
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const PRICE = 1100, TOTAL = 3000, MAX_AGE = 86400;
  let schemaPromise;

  function ensureSchema() {
    if (!schemaPromise) schemaPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS public.lottery_tickets (
        id BIGSERIAL PRIMARY KEY,
        ticket_number INTEGER NOT NULL UNIQUE CHECK (ticket_number BETWEEN 1 AND 3000),
        telegram_id BIGINT NOT NULL,
        phone VARCHAR(32) NOT NULL,
        price NUMERIC(12,2) NOT NULL DEFAULT 1100,
        receipt_code CHAR(5) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'paid',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE INDEX IF NOT EXISTS lottery_tickets_telegram_id_idx ON public.lottery_tickets(telegram_id)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS public.lottery_purchase_ledger (
        id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL,
        ticket_number INTEGER NOT NULL UNIQUE, amount NUMERIC(12,2) NOT NULL,
        receipt_code CHAR(5) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    })();
    return schemaPromise;
  }

  function verifiedUser(initData) {
    if (!BOT_TOKEN) throw new Error('Telegram bot is not configured');
    if (typeof initData !== 'string' || !initData || initData.length > 10000) throw new Error('Telegram session is missing. Open this page from Telegram.');
    const p = new URLSearchParams(initData), hash = p.get('hash'), authDate = Number(p.get('auth_date')), rawUser = p.get('user');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !rawUser) throw new Error('Invalid Telegram session data');
    if (!Number.isFinite(authDate) || Math.abs(Date.now()/1000 - authDate) > MAX_AGE) throw new Error('Telegram session expired. Reopen the app.');
    const check = [...p.entries()].filter(([k]) => k !== 'hash').sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const actual = crypto.createHmac('sha256',secret).update(check).digest(), expected = Buffer.from(hash,'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) throw new Error('Telegram session verification failed');
    let u; try { u = JSON.parse(rawUser); } catch { throw new Error('Invalid Telegram user data'); }
    if (!/^\d+$/.test(String(u?.id || ''))) throw new Error('Telegram user ID missing');
    return { id: String(u.id) };
  }

  const makeCode = () => String(crypto.randomInt(0,100000)).padStart(5,'0');
  const validPhone = p => typeof p === 'string' && /^\+?[0-9][0-9\s-]{7,18}$/.test(p.trim());

  function formatPurchaseDate(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Addis_Ababa',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(date));
  }

  function formatPurchaseTime(date) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Addis_Ababa',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(date));
  }

  router.get('/tickets', async (_req, res) => {
    try {
      await ensureSchema();
      const r = await pool.query("SELECT ticket_number FROM public.lottery_tickets WHERE status='paid' ORDER BY ticket_number");
      res.json({success: true, taken: r.rows.map(x => Number(x.ticket_number)), ticketPrice: PRICE, totalNumbers: TOTAL});
    } catch(e) {
      console.error('lottery tickets', e);
      res.status(500).json({success: false, message: 'የዕጣ ቁጥሮችን ማምጣት አልተቻለም።'});
    }
  });

  router.get('/wallet', async (req, res) => {
    try {
      const u = verifiedUser(req.get('x-telegram-init-data'));
      const r = await pool.query('SELECT balance, bonus_balance FROM public.users WHERE telegram_id=$1 LIMIT 1', [u.id]);
      if(!r.rowCount) return res.status(404).json({success: false, message: 'የዋሌት መለያው አልተገኘም። መጀመሪያ Home ገጹን ይክፈቱ።'});
      res.json({success: true, balance: Number(r.rows[0].balance||0), bonusBalance: Number(r.rows[0].bonus_balance||0)});
    } catch(e) {
      res.status(401).json({success: false, message: e.message || 'Telegram verification failed'});
    }
  });

  router.post('/purchase', async (req, res) => {
    let client, notice, buyerMessage;
    try {
      await ensureSchema();
      const u = verifiedUser(req.get('x-telegram-init-data'));
      const n = Number(req.body?.ticketNumber), phone = String(req.body?.phone||'').trim();
      
      if(!Number.isInteger(n) || n < 1 || n > TOTAL) return res.status(400).json({success: false, message: 'ከ1 እስከ 3000 ያለ ትክክለኛ ቁጥር ይምረጡ።'});
      if(!validPhone(phone)) return res.status(400).json({success: false, message: 'ትክክለኛ የስልክ ቁጥር ያስገቡ።'});

      client = await pool.connect();
      await client.query('BEGIN');

      const w = await client.query('SELECT id, balance FROM public.users WHERE telegram_id=$1 FOR UPDATE', [u.id]);
      if(!w.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({success: false, message: 'የዋሌት መለያዎ አልተገኘም። Home ገጹን ከፍተው ይሞክሩ።'});
      }
      if(Number(w.rows[0].balance||0) < PRICE) {
        await client.query('ROLLBACK');
        return res.status(400).json({success: false, message: 'በCash ዋሌትዎ 1,100 ETB አልበቃም።', balance: Number(w.rows[0].balance||0)});
      }

      const code = makeCode();
      const ins = await client.query(`
        INSERT INTO public.lottery_tickets
          (ticket_number, telegram_id, phone, price, receipt_code, status)
        VALUES ($1, $2, $3, $4, $5, 'paid')
        ON CONFLICT(ticket_number) DO NOTHING
        RETURNING id, created_at
      `, [n, u.id, phone, PRICE, code]);

      if(!ins.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({success: false, message: `ቁጥር #${n} አስቀድሞ ተይዟል። ሌላ ቁጥር ይምረጡ።`});
      }

      const upd = await client.query('UPDATE public.users SET balance=balance-$1 WHERE telegram_id=$2 AND balance >= $1 RETURNING balance', [PRICE, u.id]);
      if(!upd.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({success: false, message: 'የዋሌት ሂሳቡ ተቀይሯል። እንደገና ይሞክሩ።'});
      }

      await client.query('INSERT INTO public.lottery_purchase_ledger(telegram_id,ticket_number,amount,receipt_code) VALUES($1,$2,$3,$4)', [u.id, n, PRICE, code]);
      await client.query('COMMIT');

      const purchasedAt = ins.rows[0].created_at;

      buyerMessage =
        `🎉 <b>ሰላም ውድ ተጫዋች!</b>\n\n` +
        `የBYD Lottery ቲኬትዎን በተሳካ ሁኔታ ገዝተዋል። መልካም ዕድል! 🍀\n\n` +
        `🎟️ <b>የቲኬት ቁጥር:</b> <code>BYD-${String(n).padStart(6, '0')}</code>\n` +
        `📅 <b>የግዢ ቀን:</b> ${formatPurchaseDate(purchasedAt)}\n` +
        `🕒 <b>የግዢ ሰዓት:</b> ${formatPurchaseTime(purchasedAt)}\n` +
        `💰 <b>የቲኬት ዋጋ:</b> 1,100 ብር\n` +
        `🔐 <b>የማረጋገጫ ኮድ:</b> <code>${code}</code>\n\n` +
        `🏆 <b>የዕጣ መውጫ ቀን:</b> 29 ጥቅምት 2019 ዓ.ም.\n` +
        `⏰ <b>ሰዓት:</b> 9:00\n\n` +
        `ቲኬትዎን ይጠብቁ። መልካም ዕድል! 🎊\n` +
        `❤️ <b>BYD Lottery</b>`;

      notice = `🚗 <b>BYD Lottery — አዲስ ግዢ</b>\nTelegram ID: <code>${u.id}</code>\nቁጥር: <b>#${n}</b>\nክፍያ: <b>1,100 ETB</b>\nስልክ: <code>${phone.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code>\nReceipt: <code>${code}</code>`;

      res.json({
        success: true,
        message: `ቁጥር #${n} በተሳካ ሁኔታ ገዝተዋል።`,
        ticketNumber: n,
        receiptCode: code,
        balance: Number(upd.rows[0].balance),
        ticketPrice: PRICE
      });

    } catch(e) {
      if(client) try { await client.query('ROLLBACK'); } catch {}
      console.error('lottery purchase', e);
      if(!res.headersSent) res.status(500).json({success: false, message: 'ግዢውን መፈጸም አልተቻለም። እንደገና ይሞክሩ።'});
    } finally {
      if(client) client.release();
    }

    // ለገዢው እና ለአድሚን ማሳወቂያ ላክ።
    if (notifyBuyer && buyerMessage) {
      notifyBuyer(u.id, buyerMessage).catch(err => {
        console.error('Lottery buyer notification failed:', err.message);
      });
    }

    if (notice && notifyAdmin) {
      notifyAdmin(notice).catch(err => {
        console.error('Lottery admin notification failed:', err.message);
      });
    }
  });

  return router;
};
