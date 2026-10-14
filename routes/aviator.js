
const express = require('express');

module.exports = function (pool) {
  const router = express.Router();

  const STARTING_BALANCE = 1000;
  const MIN_BET = 1;
  const MAX_BET = 10000;

  let round = {
    id: 1,
    phase: 'waiting',
    multiplier: 1,
    crashPoint: 1,
    startedAt: null,
    bettingEndsAt: Date.now() + 10000,
    history: []
  };

  const activeBets = new Map();
  let nextRoundId = 1;
  let timerStarted = false;

  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aviator_demo_wallets (
        telegram_id TEXT PRIMARY KEY,
        balance NUMERIC(14,2) NOT NULL DEFAULT 1000,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS aviator_demo_bets (
        id BIGSERIAL PRIMARY KEY,
        round_id BIGINT NOT NULL,
        telegram_id TEXT NOT NULL,
        bet_amount NUMERIC(14,2) NOT NULL,
        cashout_multiplier NUMERIC(12,4),
        payout NUMERIC(14,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(round_id, telegram_id)
      )
    `);
  }

  const ready = initTables();

  function makeCrashPoint() {
    // Demo-only random multiplier; not an external provider result.
    const r = Math.random();
    return Math.min(100, Math.max(1, Number((0.99 / (1 - r)).toFixed(2))));
  }

  function publicRound() {
    return {
      id: round.id,
      phase: round.phase,
      multiplier: round.multiplier,
      bettingEndsAt: round.bettingEndsAt,
      history: round.history.slice(0, 10)
    };
  }

  async function ensureWallet(telegramId) {
    await pool.query(
      `INSERT INTO aviator_demo_wallets (telegram_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO NOTHING`,
      [telegramId, STARTING_BALANCE]
    );

    const result = await pool.query(
      'SELECT balance FROM aviator_demo_wallets WHERE telegram_id = $1',
      [telegramId]
    );

    return Number(result.rows[0].balance);
  }

  async function getWallet(telegramId) {
    const result = await pool.query(
      'SELECT balance FROM aviator_demo_wallets WHERE telegram_id = $1',
      [telegramId]
    );
    return result.rows.length ? Number(result.rows[0].balance) : null;
  }

  function startLoop() {
    if (timerStarted) return;
    timerStarted = true;

    setInterval(async () => {
      try {
        const now = Date.now();

        if (round.phase === 'waiting' && now >= round.bettingEndsAt) {
          round.phase = 'flying';
          round.startedAt = now;
          round.crashPoint = makeCrashPoint();
          round.multiplier = 1;
          return;
        }

        if (round.phase === 'flying') {
          const elapsed = (now - round.startedAt) / 1000;
          round.multiplier = Number(Math.exp(0.085 * elapsed).toFixed(2));

          if (round.multiplier >= round.crashPoint) {
            round.multiplier = round.crashPoint;
            round.phase = 'crashed';

            // Bets not cashed out lose their demo stake.
            await pool.query(
              `UPDATE aviator_demo_bets
               SET status = 'lost'
               WHERE round_id = $1 AND status = 'active'`,
              [round.id]
            );

            round.history.unshift({
              id: round.id,
              multiplier: round.crashPoint
            });
            round.history = round.history.slice(0, 10);

            setTimeout(() => {
              round = {
                id: ++nextRoundId,
                phase: 'waiting',
                multiplier: 1,
                crashPoint: 1,
                startedAt: null,
                bettingEndsAt: Date.now() + 10000,
                history: round.history
              };
              activeBets.clear();
            }, 4000);
          }
        }
      } catch (err) {
        console.error('Aviator demo loop error:', err.message);
      }
    }, 100);
  }

  router.get('/state', async (req, res) => {
    try {
      await ready;
      startLoop();

      const telegramId = String(req.query.telegram_id || '').trim();
      let balance = null;

      if (telegramId) {
        if (telegramId.length > 64) {
          return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        balance = await ensureWallet(telegramId);
      }

      res.json({
        success: true,
        round: publicRound(),
        balance,
        minBet: MIN_BET,
        maxBet: MAX_BET
      });
    } catch (err) {
      console.error('Aviator state error:', err.message);
      res.status(500).json({ success: false, error: 'Could not load demo game' });
    }
  });

  router.post('/bet', async (req, res) => {
    const telegramId = String(req.body.telegram_id || '').trim();
    const amount = Number(req.body.amount);

    if (!telegramId || telegramId.length > 64) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }

    if (!Number.isFinite(amount) || amount < MIN_BET ||
        amount > MAX_BET || Math.round(amount * 100) !== amount * 100) {
      return res.status(400).json({
        success: false,
        error: `Bet must be between ${MIN_BET} and ${MAX_BET}`
      });
    }

    const client = await pool.connect();

    try {
      await ready;
      startLoop();

      if (round.phase !== 'waiting' || Date.now() >= round.bettingEndsAt) {
        return res.status(409).json({ success: false, error: 'Betting is closed' });
      }

      if (activeBets.has(telegramId)) {
        return res.status(409).json({ success: false, error: 'You already placed a bet this round' });
      }

      await client.query('BEGIN');

      await client.query(
        `INSERT INTO aviator_demo_wallets (telegram_id, balance)
         VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING`,
        [telegramId, STARTING_BALANCE]
      );

      const wallet = await client.query(
        `SELECT balance FROM aviator_demo_wallets
         WHERE telegram_id = $1 FOR UPDATE`,
        [telegramId]
      );

      if (Number(wallet.rows[0].balance) < amount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Not enough demo balance' });
      }

      await client.query(
        `UPDATE aviator_demo_wallets
         SET balance = balance - $1, updated_at = NOW()
         WHERE telegram_id = $2`,
        [amount, telegramId]
      );

      await client.query(
        `INSERT INTO aviator_demo_bets
         (round_id, telegram_id, bet_amount, status)
         VALUES ($1, $2, $3, 'active')`,
        [round.id, telegramId, amount]
      );

      await client.query('COMMIT');

      activeBets.set(telegramId, { amount, roundId: round.id });

      res.json({
        success: true,
        message: 'Demo bet placed',
        balance: await getWallet(telegramId),
        round: publicRound()
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Aviator bet error:', err.message);
      res.status(500).json({ success: false, error: 'Could not place demo bet' });
    } finally {
      client.release();
    }
  });

  router.post('/cashout', async (req, res) => {
    const telegramId = String(req.body.telegram_id || '').trim();

    if (!telegramId || telegramId.length > 64) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }

    const client = await pool.connect();

    try {
      await ready;
      startLoop();

      if (round.phase !== 'flying') {
        return res.status(409).json({ success: false, error: 'Round is not flying' });
      }

      const bet = activeBets.get(telegramId);

      if (!bet || bet.roundId !== round.id) {
        return res.status(400).json({ success: false, error: 'No active bet in this round' });
      }

      const multiplier = round.multiplier;
      const payout = Math.floor(bet.amount * multiplier * 100) / 100;

      await client.query('BEGIN');

      const updated = await client.query(
        `UPDATE aviator_demo_bets
         SET status = 'cashed_out', cashout_multiplier = $1, payout = $2
         WHERE round_id = $3 AND telegram_id = $4 AND status = 'active'
         RETURNING id`,
        [multiplier, payout, round.id, telegramId]
      );

      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'Bet already settled' });
      }

      await client.query(
        `UPDATE aviator_demo_wallets
         SET balance = balance + $1, updated_at = NOW()
         WHERE telegram_id = $2`,
        [payout, telegramId]
      );

      await client.query('COMMIT');
      activeBets.delete(telegramId);

      res.json({
        success: true,
        multiplier,
        payout,
        balance: await getWallet(telegramId)
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Aviator cashout error:', err.message);
      res.status(500).json({ success: false, error: 'Could not cash out' });
    } finally {
      client.release();
    }
  });

  return router;
};
