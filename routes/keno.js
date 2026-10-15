const express = require('express');
const crypto = require('crypto');

module.exports = function createKenoRouter(pool, io) {
  const router = express.Router();

  const ROUND_SECONDS = 60;
  const DRAW_SECONDS = 15;
  const DRAW_COUNT = 20;
  const MIN_NUMBER = 1;
  const MAX_NUMBER = 80;
  const MIN_PICKS = 1;
  const MAX_PICKS = 10;
  const MIN_STAKE = 10;
  const MAX_STAKE = 1000;
  const STAKE_STEP = 10;
  const ROUND_LOCK_ID = 730241;
  const BET_LOCK_ID = 730242;

  const PAYTABLE = {
    1: { 1: 3.8 },
    2: { 2: 12 },
    3: { 2: 2, 3: 42 },
    4: { 2: 1, 3: 5, 4: 100 },
    5: { 3: 2, 4: 15, 5: 300 },
    6: { 3: 1, 4: 7, 5: 70, 6: 1000 },
    7: { 4: 3, 5: 20, 6: 200, 7: 3000 },
    8: { 4: 2, 5: 10, 6: 80, 7: 800, 8: 6000 },
    9: { 5: 5, 6: 40, 7: 300, 8: 2500, 9: 10000 },
    10: { 5: 2, 6: 15, 7: 100, 8: 800, 9: 4000, 10: 25000 }
  };

  let schemaPromise = null;
  let workerStarted = false;
  let workerTimer = null;

  function makeDraw() {
    const numbers = Array.from({ length: MAX_NUMBER }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    return numbers.slice(0, DRAW_COUNT);
  }

  function validPicks(picks) {
    return Array.isArray(picks) &&
      picks.length >= MIN_PICKS && picks.length <= MAX_PICKS &&
      picks.every(n => Number.isInteger(n) && n >= MIN_NUMBER && n <= MAX_NUMBER) &&
      new Set(picks).size === picks.length;
  }

  function validStake(stake) {
    return Number.isSafeInteger(stake) && stake >= MIN_STAKE &&
      stake <= MAX_STAKE && stake % STAKE_STEP === 0;
  }

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        // Use the same PostgreSQL schema consistently.
        await pool.query(`
          CREATE TABLE IF NOT EXISTS public.keno_rounds (
            id BIGSERIAL PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'BETTING',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            betting_ends_at TIMESTAMPTZ NOT NULL
              DEFAULT (NOW() + INTERVAL '60 seconds'),
            drawing_ends_at TIMESTAMPTZ,
            draw_numbers INTEGER[],
            closed_at TIMESTAMPTZ
          )
        `);

        await pool.query(`
          ALTER TABLE public.keno_rounds
          ADD COLUMN IF NOT EXISTS draw_numbers INTEGER[]
        `);

        await pool.query(`
          ALTER TABLE public.keno_rounds
          ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ
        `);

        await pool.query(`
          ALTER TABLE public.keno_rounds
          ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ
        `);

        await pool.query(`
          ALTER TABLE public.keno_rounds
          ADD COLUMN IF NOT EXISTS drawn_numbers jsonb
        `);

        const verify = await pool.query(`
          SELECT
            current_database() AS db,
            current_schema() AS schema_name,
            to_regclass('public.keno_rounds') AS rounds_table
        `);

        const cols = await pool.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'keno_rounds'
          ORDER BY ordinal_position
        `);

        console.log('KENO DB CHECK:', JSON.stringify(verify.rows[0]));
        console.log(
          'KENO ROUND COLUMNS:',
          JSON.stringify(cols.rows.map(row => row.column_name))
        );

        await pool.query(`
          ALTER TABLE public.keno_rounds
          ADD COLUMN IF NOT EXISTS drawing_ends_at TIMESTAMPTZ
        `);

        await pool.query(`
          ALTER TABLE public.keno_rounds
          ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ
        `);

        await pool.query(`
          ALTER TABLE public.keno_rounds
          ADD COLUMN IF NOT EXISTS betting_ends_at TIMESTAMPTZ
        `);

        // Migrate legacy Keno round states to the current format.
        await pool.query(`
          UPDATE public.keno_rounds
          SET
            status = CASE
              WHEN LOWER(status) = 'open' THEN 'BETTING'
              WHEN LOWER(status) = 'drawing' THEN 'DRAWING'
              WHEN LOWER(status) = 'closed' THEN 'CLOSED'
              ELSE status
            END,
            betting_ends_at = CASE
              WHEN LOWER(status) = 'open'
                AND betting_ends_at IS NULL
              THEN NOW() + INTERVAL '60 seconds'
              ELSE betting_ends_at
            END,
            drawing_ends_at = CASE
              WHEN LOWER(status) = 'drawing'
                AND drawing_ends_at IS NULL
              THEN NOW() + INTERVAL '15 seconds'
              ELSE drawing_ends_at
            END
          WHERE LOWER(status) IN ('open', 'drawing', 'closed')
        `);
        console.log('Keno legacy round statuses checked and migrated.');

        await pool.query(`
          CREATE TABLE IF NOT EXISTS public.keno_bets (
            id BIGSERIAL PRIMARY KEY,
            round_id BIGINT NOT NULL
              REFERENCES public.keno_rounds(id),
            identifier TEXT NOT NULL,
            picks INTEGER[],
            stake NUMERIC(14,2) NOT NULL DEFAULT 10,
            matched_count INTEGER,
            payout NUMERIC(14,2) NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'WAITING',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await pool.query(`
          ALTER TABLE public.keno_bets
          ADD COLUMN IF NOT EXISTS identifier TEXT
        `);

        await pool.query(`
          ALTER TABLE public.keno_bets
          ADD COLUMN IF NOT EXISTS picks INTEGER[]
        `);

        await pool.query(`
          ALTER TABLE public.keno_bets
          ADD COLUMN IF NOT EXISTS stake NUMERIC(14,2)
        `);

        await pool.query(`
          ALTER TABLE public.keno_bets
          ADD COLUMN IF NOT EXISTS matched_count INTEGER
        `);

        await pool.query(`
          ALTER TABLE public.keno_bets
          ADD COLUMN IF NOT EXISTS payout NUMERIC(14,2)
          NOT NULL DEFAULT 0
        `);

        await pool.query(`
          ALTER TABLE public.keno_bets
          ADD COLUMN IF NOT EXISTS status TEXT
          NOT NULL DEFAULT 'WAITING'
        `);

        await pool.query(`
          ALTER TABLE public.keno_bets
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW()
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS keno_bets_round_idx
          ON public.keno_bets(round_id)
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS keno_bets_identifier_idx
          ON public.keno_bets(identifier)
        `);

        // Separate Keno-only bonus wallet. Each Telegram ID can receive 100 ETB once.
        await pool.query(`
          CREATE TABLE IF NOT EXISTS public.keno_bonus_wallets (
            identifier TEXT PRIMARY KEY,
            balance NUMERIC(14,2) NOT NULL DEFAULT 100.00,
            bonus_claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        const check = await pool.query(`
          SELECT
            current_database() AS database_name,
            current_schema() AS active_schema,
            to_regclass('public.keno_rounds') AS rounds_table,
            to_regclass('public.keno_bets') AS bets_table
        `);

        const info = check.rows[0];

        const columns = await pool.query(`
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (
              (table_name = 'keno_rounds'
               AND column_name = 'draw_numbers')
              OR
              (table_name = 'keno_bets'
               AND column_name IN (
                 'round_id', 'identifier', 'picks', 'stake',
                 'matched_count', 'payout', 'status'
               ))
            )
          ORDER BY table_name, column_name
        `);

        const hasDrawColumn = columns.rows.some(
          row =>
            row.table_name === 'keno_rounds' &&
            row.column_name === 'draw_numbers'
        );

        if (!info.rounds_table || !info.bets_table || !hasDrawColumn) {
          throw new Error(
            `Keno schema verification failed: ${JSON.stringify(info)}`
          );
        }

        console.log(
          'Keno schema ready:',
          JSON.stringify(info),
          'columns:',
          JSON.stringify(columns.rows)
        );

        const usersCheck = await pool.query(`
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'users'
            AND column_name = 'telegram_id'
        `);

        if (!usersCheck.rowCount) {
          throw new Error(
            'public.users.telegram_id column not found'
          );
        }
      })().catch(err => {
        schemaPromise = null;
        console.error('Keno schema migration failed:', err.message);
        throw err;
      });
    }

    return schemaPromise;
  }

  async function createRound(client) {
    const result = await client.query(
      `INSERT INTO public.keno_rounds
        (
          status,
          created_at,
          starts_at,
          ends_at,
          betting_ends_at,
          drawing_ends_at,
          draw_numbers,
          drawn_numbers
        )
       VALUES (
         'BETTING',
         NOW(),
         NOW(),
         NOW() + ($1 * INTERVAL '1 second'),
         NOW() + ($1 * INTERVAL '1 second'),
         NULL,
         NULL,
         '[]'::jsonb
       )
       RETURNING *`,
      [ROUND_SECONDS]
    );

    return result.rows[0];
  }

  async function advanceRound() {
    await ensureSchema();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [ROUND_LOCK_ID]);
      if (!lock.rows[0].locked) {
        await client.query('ROLLBACK');
        return;
      }

      const result = await client.query('SELECT * FROM public.keno_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
      let round = result.rows[0];
      if (!round) {
        await createRound(client);
        await client.query('COMMIT');
        return;
      }

      const nowResult = await client.query('SELECT NOW() AS now');
      const now = new Date(nowResult.rows[0].now);

      if (round.status === 'BETTING' && round.betting_ends_at && now >= new Date(round.betting_ends_at)) {
        const draw = makeDraw();
        const drawSet = new Set(draw);
        const betsResult = await client.query(
          `SELECT id, identifier, picks, stake FROM public.keno_bets
           WHERE round_id = $1 AND status = 'WAITING' FOR UPDATE`, [round.id]
        );

        for (const bet of betsResult.rows) {
          const picks = Array.isArray(bet.picks) ? bet.picks.map(Number) : [];
          const matched = picks.filter(n => drawSet.has(n)).length;
          const multiplier = (PAYTABLE[picks.length] && PAYTABLE[picks.length][matched]) || 0;
          const payout = Number((Number(bet.stake) * multiplier).toFixed(2));
          const status = payout > 0 ? 'WON' : 'LOST';

          await client.query(
            `UPDATE public.keno_bets SET matched_count = $1, payout = $2, status = $3 WHERE id = $4`,
            [matched, payout, status, bet.id]
          );
          if (payout > 0) {
            await client.query(
              `UPDATE public.keno_bonus_wallets
               SET balance = balance + $1, updated_at = NOW()
               WHERE identifier = $2`,
              [payout, bet.identifier]
            );
          }
        }

        // እዚህ ጋር draw_numbers እና drawn_numbers በአንድ ላይ ይዘመናሉ
        await client.query(
          `UPDATE public.keno_rounds
           SET status = 'DRAWING',
               draw_numbers = $1::integer[],
               drawn_numbers = $2::jsonb,
               drawing_ends_at = NOW() + ($3 * INTERVAL '1 second')
           WHERE id = $4`,
          [draw, JSON.stringify(draw), DRAW_SECONDS, round.id]
        );
        if (io) io.emit('keno:round', { roundId: String(round.id), status: 'DRAWING', draw, drawSeconds: DRAW_SECONDS });
        await client.query('COMMIT');
        return;
      }

      if (round.status === 'DRAWING' && round.drawing_ends_at && now >= new Date(round.drawing_ends_at)) {
        await client.query(`UPDATE public.keno_rounds SET status = 'CLOSED', closed_at = NOW() WHERE id = $1`, [round.id]);
        if (io) io.emit('keno:round', { roundId: String(round.id), status: 'CLOSED' });
        await createRound(client);
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('Keno round worker error:', err.message);
    } finally {
      client.release();
    }
  }

  function startWorker() {
    if (workerStarted) return;
    workerStarted = true;
    advanceRound().catch(err => console.error('Keno initialization error:', err.message));
    workerTimer = setInterval(() => {
      advanceRound().catch(err => console.error('Keno worker error:', err.message));
    }, 1000);
    if (workerTimer.unref) workerTimer.unref();
  }

  async function getLatestRound() {
    await ensureSchema();
    await advanceRound();
    const result = await pool.query('SELECT * FROM public.keno_rounds ORDER BY id DESC LIMIT 1');
    return result.rows[0] || null;
  }

  function publicRound(round) {
    if (!round) return null;
    return {
      roundId: String(round.id),
      status: round.status,
      timeLeft: round.status === 'BETTING'
        ? Math.max(0, Math.ceil((new Date(round.betting_ends_at).getTime() - Date.now()) / 1000))
        : round.status === 'DRAWING' && round.drawing_ends_at
          ? Math.max(0, Math.ceil((new Date(round.drawing_ends_at).getTime() - Date.now()) / 1000)) : 0,
      draw: round.status === 'BETTING' ? [] : (round.draw_numbers || []),
      bettingEndsAt: round.betting_ends_at,
      drawingEndsAt: round.drawing_ends_at
    };
  }

  router.get('/status', async (req, res) => {
    try {
      const round = await getLatestRound();
      res.json({ success: true, round: publicRound(round) });
    } catch (err) {
      console.error('Keno status error:', err.message);
      res.status(500).json({ success: false, error: 'የጨዋታ ሁኔታን ማግኘት አልተቻለም።' });
    }
  });

  router.get('/bonus', async (req, res) => {
    const identifier = String(req.query.identifier || '').trim();
    if (!identifier || identifier.length > 128) {
      return res.status(400).json({ success: false, error: 'identifier (Telegram ID) ያስፈልጋል።' });
    }
    try {
      await ensureSchema();
      const user = await pool.query(
        'SELECT telegram_id FROM public.users WHERE telegram_id = $1',
        [identifier]
      );
      if (!user.rows.length) {
        return res.status(404).json({ success: false, error: 'ተጠቃሚው አልተገኘም።' });
      }
      await pool.query(
        `INSERT INTO public.keno_bonus_wallets (identifier, balance)
         VALUES ($1, 100.00)
         ON CONFLICT (identifier) DO NOTHING`,
        [identifier]
      );
      const result = await pool.query(
        `SELECT balance, bonus_claimed_at
         FROM public.keno_bonus_wallets WHERE identifier = $1`,
        [identifier]
      );
      return res.json({
        success: true,
        bonus: Number(result.rows[0].balance),
        bonusClaimedAt: result.rows[0].bonus_claimed_at,
        currency: 'ETB'
      });
    } catch (err) {
      console.error('Keno bonus error:', err.message);
      return res.status(500).json({ success: false, error: 'የKeno Bonus ማግኘት አልተቻለም።' });
    }
  });

  router.post('/play', async (req, res) => {
    const identifier = String(req.body?.identifier || '').trim();
    const picks = req.body?.picks;
    const stake = Number(req.body?.stake);

    if (!identifier || identifier.length > 128) return res.status(400).json({ success: false, error: 'ትክክለኛ የተጫዋች Telegram ID ያስፈልጋል።' });
    if (!validPicks(picks)) return res.status(400).json({ success: false, error: 'ከ1 እስከ80 ያሉ የተለያዩ 1–10 ቁጥሮችን ይምረጡ።' });
    if (!validStake(stake)) return res.status(400).json({ success: false, error: 'ውርርዱ ከ10 እስከ1000 ETB መሆን እና በ10 ETB መጨመር አለበት።' });

    try {
      await ensureSchema();
      await advanceRound();
    } catch (err) {
      console.error('Keno setup error:', err.message);
      return res.status(500).json({ success: false, error: 'የKeno ዳታቤዝ ማዘጋጀት አልተቻለም።' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [BET_LOCK_ID]);
      if (!lock.rows[0].locked) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'እባክዎ እንደገና ይሞክሩ።' });
      }

      const roundRes = await client.query('SELECT * FROM public.keno_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
      const round = roundRes.rows[0];
      if (!round || round.status !== 'BETTING' || new Date(round.betting_ends_at).getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'የውርርድ ጊዜው ተዘግቷል፤ ቀጣዩን ዙር ይጠብቁ።' });
      }

      const userRes = await client.query(
        'SELECT telegram_id FROM public.users WHERE telegram_id = $1',
        [identifier]
      );
      if (!userRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'ተጠቃሚው አልተገኘም። Telegram ID በusers.telegram_id ውስጥ መኖሩን ያረጋግጡ።' });
      }

      await pool.query(
        `INSERT INTO public.keno_bonus_wallets (identifier, balance)
         VALUES ($1, 100.00)
         ON CONFLICT (identifier) DO NOTHING`,
        [identifier]
      );
      const bonusRes = await client.query(
        'SELECT balance FROM public.keno_bonus_wallets WHERE identifier = $1 FOR UPDATE',
        [identifier]
      );
      const balance = Number(bonusRes.rows[0].balance);
      if (!Number.isFinite(balance) || balance < stake) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'በKeno Bonus ውስጥ በቂ ብር የለም።' });
      }

      const existing = await client.query('SELECT id FROM public.keno_bets WHERE round_id = $1 AND identifier = $2', [round.id, identifier]);
      if (existing.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'በዚህ ዙር ውርርድ አስቀድመው አስገብተዋል።' });
      }

      const balanceRes = await client.query(
        `UPDATE public.keno_bonus_wallets
         SET balance = balance - $1, updated_at = NOW()
         WHERE identifier = $2 RETURNING balance`,
        [stake, identifier]
      );
      const sortedPicks = [...picks].sort((a, b) => a - b);
      await client.query(
        `INSERT INTO public.keno_bets (round_id, identifier, picks, stake) VALUES ($1, $2, $3, $4)`,
        [round.id, identifier, sortedPicks, stake]
      );
      await client.query('COMMIT');

      const ticket = { roundId: String(round.id), picks: sortedPicks, stake, payout: 0, matched: null, status: 'WAITING' };
      if (io) io.emit('keno:bet', { roundId: String(round.id), ticket });
      res.json({ success: true, roundId: String(round.id), balance: Number(balanceRes.rows[0].balance), ticket });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (err.code === '23505') return res.status(409).json({ success: false, error: 'በዚህ ዙር ውርርድ አስቀድመው አስገብተዋል።' });
      console.error('Keno bet error:', err.message);
      res.status(500).json({ success: false, error: 'ውርርዱን መመዝገብ አልተቻለም።' });
    } finally {
      client.release();
    }
  });

  router.get('/tickets', async (req, res) => {
    const identifier = String(req.query.identifier || '').trim();
    if (!identifier) return res.status(400).json({ success: false, error: 'identifier (Telegram ID) ያስፈልጋል።' });
    try {
      await ensureSchema();
      const result = await pool.query(
        `SELECT b.id, b.round_id, b.picks, b.stake, b.matched_count, b.payout, b.status, b.created_at,
                r.draw_numbers, r.status AS round_status
         FROM public.keno_bets b JOIN public.keno_rounds r ON r.id = b.round_id
         WHERE b.identifier = $1 ORDER BY b.id DESC LIMIT 30`, [identifier]
      );
      res.json({ success: true, tickets: result.rows.map(row => ({
        id: String(row.id), roundId: String(row.round_id), picks: row.picks || [], stake: Number(row.stake),
        matched: row.matched_count == null ? null : Number(row.matched_count), payout: Number(row.payout),
        status: row.status, createdAt: row.created_at, draw: row.draw_numbers || [], roundStatus: row.round_status
      })) });
    } catch (err) {
      console.error('Keno tickets error:', err.message);
      res.status(500).json({ success: false, error: 'የቲኬት ታሪክ ማግኘት አልተቻለም።' });
    }
  });

  router.get('/health', (req, res) => {
    res.json({
      success: true,
      route: 'keno',
      message: 'Keno routes are loaded'
    });
  });

  router.get('/results', async (req, res) => {
    try {
      await ensureSchema();
      const result = await pool.query(`
        SELECT id, status, created_at, draw_numbers, closed_at
        FROM public.keno_rounds
        WHERE status IN ('DRAWING', 'CLOSED')
        ORDER BY id DESC
        LIMIT 20
      `);
      res.json({ success: true, results: result.rows.map(row => ({
        roundId: String(row.id), status: row.status, createdAt: row.created_at,
        draw: row.draw_numbers || [], closedAt: row.closed_at
      })) });
    } catch (err) {
      console.error('Keno results error:', err.message);
      res.status(500).json({ success: false, error: 'ውጤቶችን ማግኘት አልተቻለም።' });
    }
  });

  startWorker();
  return router;
};
