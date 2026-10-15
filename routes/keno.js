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
    1: { 1: 3.8 }, 2: { 2: 15 }, 3: { 2: 2, 3: 30 },
    4: { 2: 1, 3: 6, 4: 100 }, 5: { 3: 3, 4: 15, 5: 400 },
    6: { 3: 1, 4: 6, 5: 50, 6: 1200 },
    7: { 4: 3, 5: 15, 6: 150, 7: 3000 },
    8: { 4: 2, 5: 10, 6: 60, 7: 600, 8: 8000 },
    9: { 5: 5, 6: 30, 7: 250, 8: 2000, 9: 12000 },
    10: { 5: 2, 6: 12, 7: 80, 8: 600, 9: 3000, 10: 20000 }
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
    return Array.isArray(picks) && picks.length >= MIN_PICKS && picks.length <= MAX_PICKS &&
      picks.every(n => Number.isInteger(n) && n >= MIN_NUMBER && n <= MAX_NUMBER) &&
      new Set(picks).size === picks.length;
  }

  function validStake(stake) {
    return Number.isSafeInteger(stake) && stake >= MIN_STAKE && stake <= MAX_STAKE && stake % STAKE_STEP === 0;
  }

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS public.keno_rounds (
          id BIGSERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'BETTING',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          betting_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 seconds'),
          drawing_ends_at TIMESTAMPTZ, draw_numbers INTEGER[], closed_at TIMESTAMPTZ,
          starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, drawn_numbers JSONB DEFAULT '[]'::jsonb
        )`);
        console.log('Keno schema ready.');
      })().catch(err => { schemaPromise = null; console.error('Keno schema migration failed:', err.message); throw err; });
    }
    return schemaPromise;
  }

  async function createRound(client) {
    const result = await client.query(`INSERT INTO public.keno_rounds
      (status, created_at, starts_at, ends_at, betting_ends_at, drawing_ends_at, draw_numbers, drawn_numbers)
      VALUES ('BETTING', NOW(), NOW(), NOW() + ($1 * INTERVAL '1 second'), NOW() + ($1 * INTERVAL '1 second'), NULL, NULL, '[]'::jsonb)
      RETURNING *`, [ROUND_SECONDS]);
    return result.rows[0];
  }

  async function advanceRound() {
    await ensureSchema();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [ROUND_LOCK_ID]);
      if (!lock.rows[0].locked) { await client.query('ROLLBACK'); return; }
      const result = await client.query('SELECT * FROM public.keno_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
      let round = result.rows[0];
      if (!round) { await createRound(client); await client.query('COMMIT'); return; }
      const nowResult = await client.query('SELECT NOW() AS now');
      const now = new Date(nowResult.rows[0].now);
      if (round.status === 'BETTING' && round.betting_ends_at && now >= new Date(round.betting_ends_at)) {
        const draw = makeDraw();
        const drawSet = new Set(draw);
        const betsResult = await client.query(`SELECT id, identifier, picks, stake FROM public.keno_bets WHERE round_id=$1 AND status='WAITING' FOR UPDATE`, [round.id]);
        for (const bet of betsResult.rows) {
          const picks = Array.isArray(bet.picks) ? bet.picks.map(Number) : [];
          const matched = picks.filter(n => drawSet.has(n)).length;
          const multiplier = (PAYTABLE[picks.length] && PAYTABLE[picks.length][matched]) || 0;
          const payout = Number((Number(bet.stake) * multiplier).toFixed(2));
          const status = payout > 0 ? 'WON' : 'LOST';
          await client.query(`UPDATE public.keno_bets SET matched_count=$1, payout=$2, status=$3 WHERE id=$4`, [matched, payout, status, bet.id]);
          if (payout > 0) {
            await client.query(`UPDATE public.users SET balance=balance+$1 WHERE telegram_id=$2`, [payout, bet.identifier]);
          }
        }
        await client.query(`UPDATE public.keno_rounds SET status='DRAWING', draw_numbers=$1::integer[], drawn_numbers=$2::jsonb, drawing_ends_at=NOW()+($3 * INTERVAL '1 second') WHERE id=$4`, [draw, JSON.stringify(draw), DRAW_SECONDS, round.id]);
        await client.query('COMMIT');
        if (io) io.emit('keno:round', { roundId: String(round.id), status: 'DRAWING', draw, drawSeconds: DRAW_SECONDS });
        return;
      }
      if (round.status === 'DRAWING' && round.drawing_ends_at && now >= new Date(round.drawing_ends_at)) {
        await client.query(`UPDATE public.keno_rounds SET status='CLOSED', closed_at=NOW() WHERE id=$1`, [round.id]);
        await createRound(client);
        await client.query('COMMIT');
        if (io) io.emit('keno:round', { roundId: String(round.id), status: 'CLOSED' });
        return;
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('Keno round worker error:', err.message);
    } finally { client.release(); }
  }

  function startWorker() {
    if (workerStarted) return;
    workerStarted = true;
    advanceRound().catch(err => console.error('Keno initialization error:', err.message));
    workerTimer = setInterval(() => advanceRound().catch(err => console.error('Keno worker error:', err.message)), 1000);
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
      roundId: String(round.id), status: round.status,
      timeLeft: round.status === 'BETTING' ? Math.max(0, Math.ceil((new Date(round.betting_ends_at).getTime() - Date.now()) / 1000)) :
        round.status === 'DRAWING' && round.drawing_ends_at ? Math.max(0, Math.ceil((new Date(round.drawing_ends_at).getTime() - Date.now()) / 1000)) : 0,
      draw: round.status === 'BETTING' ? [] : (round.draw_numbers || []),
      bettingEndsAt: round.betting_ends_at, drawingEndsAt: round.drawing_ends_at
    };
  }

  router.get('/bonus', async (req, res) => {
    const identifier = String(req.query.identifier || '').trim();
    if (!identifier) return res.status(400).json({ success: false, error: 'identifier ያስፈልጋል።' });
    try {
      await ensureSchema();
      const result = await pool.query(`SELECT balance, bonus_balance FROM public.users WHERE telegram_id=$1`, [identifier]);
      if (!result.rowCount) return res.status(404).json({ success: false, error: 'ተጠቃሚው አልተገኘም።' });
      return res.json({ success: true, balance: Number(result.rows[0].balance), currency: 'ETB' });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'የዋናውን ዋሌት ማግኘት አልተቻለም።' });
    }
  });

  router.get('/status', async (req, res) => {
    try { const round = await getLatestRound(); res.json({ success: true, round: publicRound(round) }); }
    catch (err) { res.status(500).json({ success: false, error: 'የጨዋታ ሁኔታን ማግኘት አልተቻለም።' }); }
  });

  router.post('/play', async (req, res) => {
    const identifier = String(req.body?.identifier || '').trim();
    const picks = req.body?.picks;
    const stake = Number(req.body?.stake);
    if (!identifier) return res.status(400).json({ success: false, error: 'Telegram ID ያስፈልጋል።' });
    if (!validPicks(picks)) return res.status(400).json({ success: false, error: 'ከ1 እስከ 80 ያሉ 1–10 ቁጥሮች ይምረጡ።' });
    if (!validStake(stake)) return res.status(400).json({ success: false, error: 'ትክክለኛ ውርርድ ያስገቡ።' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [BET_LOCK_ID]);
      if (!lock.rows[0].locked) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'እባክዎ እንደገና ይሞክሩ።' }); }
      
      const roundRes = await client.query('SELECT * FROM public.keno_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
      const round = roundRes.rows[0];
      if (!round || round.status !== 'BETTING' || new Date(round.betting_ends_at).getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'የውርርድ ጊዜው ተዘግቷል።' });
      }

      const userRes = await client.query('SELECT balance FROM public.users WHERE telegram_id=$1 FOR UPDATE', [identifier]);
      if (!userRes.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'ተጠቃሚው አልተገኘም።' }); }
      
      const balance = Number(userRes.rows[0].balance);
      if (balance < stake) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'በዋሌትዎ ውስጥ በቂ ብር የለም።' }); }

      // ─── በርካታ ቲኬቶችን ለመፍቀድ የድሮው existing check (existing.rowCount) ሙሉ በሙሉ ተወግዷል! ───

      const debited = await client.query('UPDATE public.users SET balance=balance-$1 WHERE telegram_id=$2 AND balance >= $1 RETURNING balance', [stake, identifier]);
      if (!debited.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'በቂ ብር የለም።' }); }

      const sortedPicks = [...picks].sort((a, b) => a - b);
      await client.query(
        `INSERT INTO public.keno_bets (round_id, identifier, telegram_id, numbers, picks, stake) VALUES ($1, $2, $2, $3::jsonb, $4::integer[], $5)`,
        [round.id, identifier, JSON.stringify(sortedPicks), sortedPicks, stake]
      );
      
      await client.query('COMMIT');
      const ticket = { roundId: String(round.id), picks: sortedPicks, stake, payout: 0, status: 'WAITING' };
      if (io) io.emit('keno:bet', { roundId: String(round.id), ticket });
      return res.json({ success: true, roundId: String(round.id), balance: Number(debited.rows[0].balance), ticket });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('Keno bet error:', err.message);
      return res.status(500).json({ success: false, error: 'ውርርዱን መመዝገብ አልተቻለም።' });
    } finally { client.release(); }
  });

  router.get('/tickets', async (req, res) => {
    const identifier = String(req.query.identifier || '').trim();
    if (!identifier) return res.status(400).json({ success: false, error: 'identifier ያስፈልጋል።' });
    try {
      await ensureSchema();
      const result = await pool.query(`SELECT b.id,b.round_id,b.picks,b.stake,b.matched_count,b.payout,b.status,b.created_at,r.draw_numbers,r.status AS round_status
        FROM public.keno_bets b JOIN public.keno_rounds r ON r.id=b.round_id WHERE b.identifier=$1 ORDER BY b.id DESC LIMIT 30`, [identifier]);
      return res.json({ success: true, tickets: result.rows.map(row => ({ id: String(row.id), roundId: String(row.round_id), picks: row.picks || [], stake: Number(row.stake), matched: row.matched_count == null ? null : Number(row.matched_count), payout: Number(row.payout), status: row.status, createdAt: row.created_at, draw: row.draw_numbers || [], roundStatus: row.round_status })) });
    } catch (err) { return res.status(500).json({ success: false, error: 'ቲኬት ማግኘት አልተቻለም።' }); }
  });

  router.get('/results', async (req, res) => {
    try {
      await ensureSchema();
      const result = await pool.query(`SELECT id,status,created_at,draw_numbers,closed_at FROM public.keno_rounds WHERE status IN ('DRAWING','CLOSED') ORDER BY id DESC LIMIT 20`);
      return res.json({ success: true, results: result.rows.map(row => ({ roundId: String(row.id), status: row.status, createdAt: row.created_at, draw: row.draw_numbers || [], closedAt: row.closed_at })) });
    } catch (err) { return res.status(500).json({ success: false, error: 'ውጤት ማግኘት አልተቻለም።' }); }
  });

  router.get('/health', (req, res) => res.json({ success: true, route: 'keno', message: 'Keno routes loaded' }));
  startWorker();
  return router;
};
