
const express = require('express');

module.exports = function (pool) {
  const router = express.Router();

  const ROUND_SECONDS = 60;
  const DRAW_COUNT = 20;
  const MIN_PICK = 1;
  const MAX_PICK = 10;
  const MIN_STAKE = 1;
  const MAX_STAKE = 10000;

  // ይህ የሙከራ የክፍያ ሰንጠረዥ ነው።
  // ከእውነተኛ ገንዘብ በፊት በጥንቃቄ አስተካክለው።
  const PAYOUTS = {
    1: { 1: 3 },
    2: { 2: 12, 1: 1 },
    3: { 3: 40, 2: 2 },
    4: { 4: 100, 3: 5, 2: 1 },
    5: { 5: 300, 4: 15, 3: 2 },
    6: { 6: 600, 5: 40, 4: 5, 3: 1 },
    7: { 7: 1000, 6: 100, 5: 10, 4: 2 },
    8: { 8: 2000, 7: 200, 6: 25, 5: 4 },
    9: { 9: 4000, 8: 400, 7: 50, 6: 8 },
    10: { 10: 10000, 9: 1000, 8: 100, 7: 15 }
  };

  let schemaReady = null;

  async function initSchema() {
    if (schemaReady) return schemaReady;

    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS keno_rounds (
          id BIGSERIAL PRIMARY KEY,
          status VARCHAR(20) NOT NULL DEFAULT 'open',
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ends_at TIMESTAMPTZ NOT NULL,
          drawn_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS keno_bets (
          id BIGSERIAL PRIMARY KEY,
          round_id BIGINT NOT NULL REFERENCES keno_rounds(id),
          telegram_id TEXT NOT NULL,
          numbers JSONB NOT NULL,
          stake NUMERIC(12,2) NOT NULL CHECK (stake > 0),
          matches INTEGER NOT NULL DEFAULT 0,
          payout NUMERIC(12,2) NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_keno_bets_user
        ON keno_bets (telegram_id, id DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_keno_bets_round
        ON keno_bets (round_id)
      `);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });

    return schemaReady;
  }

  function getTelegramId(req) {
    const value = req.body?.telegram_id ??
      req.query?.telegram_id ??
      req.params?.telegram_id;

    if (value === undefined || value === null || !/^\d+$/.test(String(value))) {
      return null;
    }

    return String(value);
  }

  function validateNumbers(numbers) {
    if (!Array.isArray(numbers)) {
      return 'Numbers must be an array.';
    }

    if (numbers.length < MIN_PICK || numbers.length > MAX_PICK) {
      return `Choose between ${MIN_PICK} and ${MAX_PICK} numbers.`;
    }

    if (!numbers.every(
      (n) => Number.isInteger(n) && n >= 1 && n <= 80
    )) {
      return 'Every number must be an integer from 1 to 80.';
    }

    if (new Set(numbers).size !== numbers.length) {
      return 'Duplicate numbers are not allowed.';
    }

    return null;
  }

  function drawNumbers() {
    const numbers = Array.from({ length: 80 }, (_, i) => i + 1);

    // Fisher-Yates shuffle
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }

    return numbers.slice(0, DRAW_COUNT).sort((a, b) => a - b);
  }

  function getPayoutMultiplier(pickedCount, matchCount) {
    return Number(PAYOUTS[pickedCount]?.[matchCount] || 0);
  }

  async function getOrCreateRound(client) {
    // Prevent two server requests from creating rounds at the same time.
    await client.query('SELECT pg_advisory_xact_lock($1)', [730241]);

    const result = await client.query(`
      SELECT *
      FROM keno_rounds
      WHERE status = 'open'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `);

    if (result.rows.length) {
      return result.rows[0];
    }

    const created = await client.query(`
      INSERT INTO keno_rounds (status, starts_at, ends_at)
      VALUES ('open', NOW(), NOW() + ($1 * INTERVAL '1 second'))
      RETURNING *
    `, [ROUND_SECONDS]);

    return created.rows[0];
  }

  async function settleExpiredRound(client) {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730241]);

    const result = await client.query(`
      SELECT *
      FROM keno_rounds
      WHERE status = 'open'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `);

    if (!result.rows.length) return null;

    const round = result.rows[0];

    if (new Date(round.ends_at).getTime() > Date.now()) {
      return round;
    }

    const drawn = drawNumbers();

    await client.query(`
      UPDATE keno_rounds
      SET status = 'completed', drawn_numbers = $1::jsonb
      WHERE id = $2
    `, [JSON.stringify(drawn), round.id]);

    const bets = await client.query(`
      SELECT *
      FROM keno_bets
      WHERE round_id = $1 AND status = 'pending'
      FOR UPDATE
    `, [round.id]);

    for (const bet of bets.rows) {
      const selected = Array.isArray(bet.numbers) ? bet.numbers : [];
      const matches = selected.filter((n) => drawn.includes(n)).length;
      const multiplier = getPayoutMultiplier(selected.length, matches);
      const payout = Math.round(Number(bet.stake) * multiplier * 100) / 100;

      await client.query(`
        UPDATE keno_bets
        SET matches = $1, payout = $2, status = 'settled'
        WHERE id = $3
      `, [matches, payout, bet.id]);

      if (payout > 0) {
        await client.query(`
          UPDATE users
          SET balance = balance + $1
          WHERE telegram_id = $2
        `, [payout, bet.telegram_id]);
      }
    }

    return {
      ...round,
      status: 'completed',
      drawn_numbers: drawn
    };
  }

  async function withTransaction(callback) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Ensure database tables exist before using the API.
  router.use(async (req, res, next) => {
    try {
      await initSchema();
      next();
    } catch (err) {
      console.error('Keno database setup error:', err.message);
      res.status(500).json({
        success: false,
        error: 'Keno database setup failed.'
      });
    }
  });

  // GET /api/keno/state
  router.get('/state', async (req, res) => {
    try {
      const data = await withTransaction(async (client) => {
        await settleExpiredRound(client);
        const round = await getOrCreateRound(client);

        const recent = await client.query(`
          SELECT id, status, starts_at, ends_at, drawn_numbers
          FROM keno_rounds
          WHERE status = 'completed'
          ORDER BY id DESC
          LIMIT 5
        `);

        return { round, recent: recent.rows };
      });

      const remaining = Math.max(
        0,
        Math.ceil((new Date(data.round.ends_at).getTime() - Date.now()) / 1000)
      );

      res.json({
        success: true,
        round: {
          id: data.round.id,
          status: data.round.status,
          starts_at: data.round.starts_at,
          ends_at: data.round.ends_at,
          seconds_remaining: remaining,
          drawn_numbers: data.round.drawn_numbers || []
        },
        recent_rounds: data.recent
      });
    } catch (err) {
      console.error('Keno state error:', err.message);
      res.status(500).json({ success: false, error: 'Could not load Keno state.' });
    }
  });

  // GET /api/keno/balance/:telegram_id
  router.get('/balance/:telegram_id', async (req, res) => {
    try {
      const telegramId = getTelegramId(req);

      if (!telegramId) {
        return res.status(400).json({ success: false, error: 'Invalid Telegram ID.' });
      }

      const result = await pool.query(`
        SELECT balance, bonus_balance
        FROM users
        WHERE telegram_id = $1
      `, [telegramId]);

      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'User not found.' });
      }

      res.json({
        success: true,
        balance: Number(result.rows[0].balance),
        bonus_balance: Number(result.rows[0].bonus_balance)
      });
    } catch (err) {
      console.error('Keno balance error:', err.message);
      res.status(500).json({ success: false, error: 'Could not load balance.' });
    }
  });

  // POST /api/keno/bet
  // Body: { telegram_id, numbers: [3, 12, 25], stake: 10 }
  router.post('/bet', async (req, res) => {
    const telegramId = getTelegramId(req);
    const { numbers, stake } = req.body || {};

    if (!telegramId) {
      return res.status(400).json({ success: false, error: 'Valid Telegram ID is required.' });
    }

    const numberError = validateNumbers(numbers);
    if (numberError) {
      return res.status(400).json({ success: false, error: numberError });
    }

    const amount = Number(stake);

    if (!Number.isFinite(amount) || amount < MIN_STAKE || amount > MAX_STAKE) {
      return res.status(400).json({
        success: false,
        error: `Stake must be between ${MIN_STAKE} and ${MAX_STAKE} ETB.`
      });
    }

    if (Math.round(amount * 100) !== amount * 100) {
      return res.status(400).json({
        success: false,
        error: 'Stake can have at most two decimal places.'
      });
    }

    try {
      const result = await withTransaction(async (client) => {
        await settleExpiredRound(client);
        const round = await getOrCreateRound(client);

        if (new Date(round.ends_at).getTime() <= Date.now()) {
          throw Object.assign(new Error('Betting time has ended. Please try the next round.'), {
            statusCode: 409
          });
        }

        const userResult = await client.query(`
          SELECT telegram_id, balance
          FROM users
          WHERE telegram_id = $1
          FOR UPDATE
        `, [telegramId]);

        if (!userResult.rows.length) {
          throw Object.assign(new Error('User not found. Open the app through Telegram first.'), {
            statusCode: 404
          });
        }

        const balance = Number(userResult.rows[0].balance);

        if (!Number.isFinite(balance) || balance < amount) {
          throw Object.assign(new Error('Insufficient cash balance.'), {
            statusCode: 400
          });
        }

        await client.query(`
          UPDATE users
          SET balance = balance - $1
          WHERE telegram_id = $2
        `, [amount, telegramId]);

        const betResult = await client.query(`
          INSERT INTO keno_bets
            (round_id, telegram_id, numbers, stake, status)
          VALUES ($1, $2, $3::jsonb, $4, 'pending')
          RETURNING id, round_id, numbers, stake, status, created_at
        `, [round.id, telegramId, JSON.stringify([...numbers].sort((a, b) => a - b)), amount]);

        const newBalance = await client.query(`
          SELECT balance, bonus_balance
          FROM users
          WHERE telegram_id = $1
        `, [telegramId]);

        return {
          bet: betResult.rows[0],
          balance: Number(newBalance.rows[0].balance),
          bonus_balance: Number(newBalance.rows[0].bonus_balance),
          seconds_remaining: Math.max(
            0,
            Math.ceil((new Date(round.ends_at).getTime() - Date.now()) / 1000)
          )
        };
      });

      res.status(201).json({
        success: true,
        message: 'Bet accepted.',
        bet: result.bet,
        balance: result.balance,
        bonus_balance: result.bonus_balance,
        seconds_remaining: result.seconds_remaining
      });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }

      console.error('Keno bet error:', err.message);
      res.status(500).json({ success: false, error: 'Could not place bet.' });
    }
  });

  // GET /api/keno/history/:telegram_id
  router.get('/history/:telegram_id', async (req, res) => {
    try {
      const telegramId = getTelegramId(req);

      if (!telegramId) {
        return res.status(400).json({ success: false, error: 'Invalid Telegram ID.' });
      }

      const result = await pool.query(`
        SELECT
          b.id,
          b.round_id,
          b.numbers,
          b.stake,
          b.matches,
          b.payout,
          b.status,
          b.created_at,
          r.drawn_numbers
        FROM keno_bets b
        JOIN keno_rounds r ON r.id = b.round_id
        WHERE b.telegram_id = $1
        ORDER BY b.id DESC
        LIMIT 50
      `, [telegramId]);

      res.json({ success: true, bets: result.rows });
    } catch (err) {
      console.error('Keno history error:', err.message);
      res.status(500).json({ success: false, error: 'Could not load Keno history.' });
    }
  });

  return router;
};
