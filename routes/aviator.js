const express = require('express');
const crypto = require('crypto');

module.exports = function (pool) {
  const r = express.Router();
  const BOT = process.env.TELEGRAM_BOT_TOKEN || '';
  const MIN = Number(process.env.AVIATOR_MIN_BET || 1);
  const MAX = Number(process.env.AVIATOR_MAX_BET || 10000);
  const EDGE = Math.min(0.20, Math.max(0, Number(process.env.AVIATOR_HOUSE_EDGE ?? 0.20)));
  const BET_MS = Math.max(4000, Number(process.env.AVIATOR_BETTING_MS || 8000));
  const LOCK = 730242;
  let ready = false, ticking = false;

  function authData(s) {
    if (!BOT || !s) return null;
    try {
      const p = new URLSearchParams(s), hash = p.get('hash');
      if (!hash) return null;
      p.delete('hash');
      const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
      const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
      const expected = crypto.createHmac('sha256', secret).update(check).digest('hex');
      const a = Buffer.from(hash, 'hex'), b = Buffer.from(expected, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const ts = Number(p.get('auth_date') || 0);
      if (!ts || Math.abs(Date.now() / 1000 - ts) > 86400) return null;
      const u = JSON.parse(p.get('user') || 'null');
      return u && u.id ? String(u.id) : null;
    } catch (_) { return null; }
  }

  async function schema() {
    if (ready) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.aviator_rounds (
        id BIGSERIAL PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('BETTING','FLYING','CRASHED')),
        crash_point NUMERIC(10,2), started_at TIMESTAMPTZ,
        betting_ends_at TIMESTAMPTZ NOT NULL, crashed_at TIMESTAMPTZ,
        total_stakes NUMERIC(14,2) NOT NULL DEFAULT 0,
        platform_share NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.aviator_bets (
        id BIGSERIAL PRIMARY KEY,
        round_id BIGINT NOT NULL REFERENCES public.aviator_rounds(id),
        telegram_id TEXT NOT NULL,
        slot SMALLINT NOT NULL DEFAULT 1 CHECK (slot IN (1,2)),
        stake NUMERIC(14,2) NOT NULL CHECK (stake > 0),
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CASHED_OUT','LOST')),
        cashout_multiplier NUMERIC(10,2), payout NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), settled_at TIMESTAMPTZ
      );
      ALTER TABLE public.aviator_bets ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 1;
      ALTER TABLE public.aviator_bets DROP CONSTRAINT IF EXISTS aviator_bets_round_id_telegram_id_key;
      CREATE UNIQUE INDEX IF NOT EXISTS aviator_bets_round_user_slot_uq ON public.aviator_bets(round_id, telegram_id, slot);
      CREATE TABLE IF NOT EXISTS public.aviator_ledger (
        id BIGSERIAL PRIMARY KEY, telegram_id TEXT NOT NULL, round_id BIGINT,
        bet_id BIGINT, entry_type TEXT NOT NULL, amount NUMERIC(14,2) NOT NULL,
        balance_after NUMERIC(14,2) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    ready = true;
  }

  function crashPoint() {
    const x = crypto.randomInt(1, 1000000) / 1000000;
    return Math.max(1, Math.min(100, Math.floor(((1 - EDGE) / (1 - x)) * 100) / 100));
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await schema();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
        let q = await c.query('SELECT * FROM public.aviator_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
        let a = q.rows[0];
        if (!a || a.status === 'CRASHED') {
          q = await c.query(`INSERT INTO public.aviator_rounds(status, betting_ends_at) VALUES ('BETTING', NOW()+($1*INTERVAL '1 millisecond')) RETURNING *`, [BET_MS]);
          a = q.rows[0];
        } else if (a.status === 'BETTING' && Date.now() >= new Date(a.betting_ends_at).getTime()) {
          q = await c.query(`UPDATE public.aviator_rounds SET status='FLYING', crash_point=$1, started_at=NOW() WHERE id=$2 RETURNING *`, [crashPoint(), a.id]);
          a = q.rows[0];
        } else if (a.status === 'FLYING' && Math.exp((Date.now() - new Date(a.started_at).getTime()) / 10000) >= Number(a.crash_point)) {
          await c.query(`UPDATE public.aviator_rounds SET status='CRASHED', crashed_at=NOW() WHERE id=$1`, [a.id]);
          await c.query(`UPDATE public.aviator_bets SET status='LOST', settled_at=NOW() WHERE round_id=$1 AND status='ACTIVE'`, [a.id]);
        }
        await c.query('COMMIT');
      } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
      finally { c.release(); }
    } catch (e) { console.error('Aviator tick:', e.message); }
    finally { ticking = false; }
  }
  setInterval(tick, 250);
  tick();

  async function auth(req, res, next) {
    try {
      await schema();
      const id = authData(req.get('x-telegram-init-data') || req.body?.initData);
      if (!id) return res.status(401).json({ success: false, error: 'Telegram Web App ሴሽን አልተረጋገጠም። በTelegram ውስጥ ይክፈቱ።' });
      req.tid = id; next();
    } catch (e) { console.error(e); res.status(500).json({ success: false, error: 'Database error' }); }
  }

  r.get('/state', auth, async (req, res) => {
    try {
      await tick();
      const c = await pool.connect();
      try {
        const u = await c.query('SELECT balance FROM public.users WHERE telegram_id=$1', [req.tid]);
        if (!u.rows.length) return res.status(404).json({ success: false, error: 'ተጠቃሚው በpublic.users ውስጥ አልተገኘም።' });
        const q = await c.query('SELECT * FROM public.aviator_rounds ORDER BY id DESC LIMIT 1');
        const a = q.rows[0];
        const b = await c.query('SELECT slot,status,stake,cashout_multiplier,payout FROM public.aviator_bets WHERE round_id=$1 AND telegram_id=$2 ORDER BY slot', [a.id, req.tid]);
        const h = await c.query(`SELECT id, crash_point AS multiplier FROM public.aviator_rounds WHERE status='CRASHED' ORDER BY id DESC LIMIT 12`);
        const bets = [null, null];
        for (const x of b.rows) bets[Number(x.slot) - 1] = { slot: Number(x.slot), status: x.status, stake: Number(x.stake), multiplier: x.cashout_multiplier == null ? null : Number(x.cashout_multiplier), payout: Number(x.payout) };
        let m = 1;
        if (a.status === 'FLYING') m = Math.floor(Math.exp(Math.max(0, Date.now() - new Date(a.started_at).getTime()) / 10000) * 100) / 100;
        res.json({ success: true, balance: Number(u.rows[0].balance), minBet: MIN, maxBet: MAX,
          round: { id: String(a.id), phase: a.status.toLowerCase(), multiplier: m, bettingEndsAt: new Date(a.betting_ends_at).getTime(), history: h.rows.map(x => ({ id: String(x.id), multiplier: Number(x.multiplier) })) },
          myBets: bets, myBet: bets.find(Boolean) || null });
      } finally { c.release(); }
    } catch (e) { console.error(e); res.status(500).json({ success: false, error: 'State error' }); }
  });

  r.post('/bet', auth, async (req, res) => {
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const slot = Number(req.body?.slot || 1);
    if (!Number.isInteger(slot) || ![1, 2].includes(slot)) return res.status(400).json({ success: false, error: 'Bet slot must be 1 or 2.' });
    if (!Number.isFinite(amount) || amount < MIN || amount > MAX) return res.status(400).json({ success: false, error: `Bet must be ${MIN}-${MAX} ETB` });
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      const q = await c.query('SELECT * FROM public.aviator_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE'); const a = q.rows[0];
      if (!a || a.status !== 'BETTING' || Date.now() >= new Date(a.betting_ends_at).getTime()) { await c.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'የውርርድ ጊዜው ተዘግቷል።' }); }
      const u = await c.query('SELECT balance FROM public.users WHERE telegram_id=$1 FOR UPDATE', [req.tid]);
      if (!u.rows.length) { await c.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'የዋሌት ተጠቃሚ አልተገኘም።' }); }
      if (Number(u.rows[0].balance) < amount) { await c.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'በዋሌትዎ ውስጥ በቂ ብር የለም።' }); }
      const old = await c.query('SELECT id FROM public.aviator_bets WHERE round_id=$1 AND telegram_id=$2 AND slot=$3', [a.id, req.tid, slot]);
      if (old.rows.length) { await c.query('ROLLBACK'); return res.status(409).json({ success: false, error: `በዚህ ዙር BET ${slot} አስቀድሞ ገብቷል።` }); }
      const w = await c.query('UPDATE public.users SET balance=balance-$1 WHERE telegram_id=$2 RETURNING balance', [amount, req.tid]);
      const b = await c.query('INSERT INTO public.aviator_bets(round_id,telegram_id,slot,stake) VALUES($1,$2,$3,$4) RETURNING id', [a.id, req.tid, slot, amount]);
      await c.query('UPDATE public.aviator_rounds SET total_stakes=total_stakes+$1, platform_share=platform_share+($1*$2) WHERE id=$3', [amount, EDGE, a.id]);
      await c.query(`INSERT INTO public.aviator_ledger(telegram_id,round_id,bet_id,entry_type,amount,balance_after) VALUES($1,$2,$3,'BET',$4,$5)`, [req.tid, a.id, b.rows[0].id, -amount, w.rows[0].balance]);
      await c.query('COMMIT'); res.json({ success: true, slot, balance: Number(w.rows[0].balance), message: `BET ${slot} ተቀብሏል።` });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} console.error(e); res.status(500).json({ success: false, error: 'Bet failed' }); }
    finally { c.release(); }
  });

  r.post('/cashout', auth, async (req, res) => {
    const slot = Number(req.body?.slot || 1);
    if (!Number.isInteger(slot) || ![1, 2].includes(slot)) return res.status(400).json({ success: false, error: 'Cash-out slot must be 1 or 2.' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      const q = await c.query('SELECT * FROM public.aviator_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE'); const a = q.rows[0];
      if (!a || a.status !== 'FLYING') { await c.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'Cash Out አሁን አይቻልም።' }); }
      const elapsed = Math.max(0, Date.now() - new Date(a.started_at).getTime()); const m = Math.floor(Math.exp(elapsed / 10000) * 100) / 100;
      if (m >= Number(a.crash_point)) { await c.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'አውሮፕላኑ ወድቋል።' }); }
      const q2 = await c.query('SELECT * FROM public.aviator_bets WHERE round_id=$1 AND telegram_id=$2 AND slot=$3 FOR UPDATE', [a.id, req.tid, slot]); const b = q2.rows[0];
      if (!b || b.status !== 'ACTIVE') { await c.query('ROLLBACK'); return res.status(409).json({ success: false, error: `BET ${slot} ንቁ አይደለም።` }); }
      const pay = Math.floor(Number(b.stake) * m * 100) / 100;
      const w = await c.query('UPDATE public.users SET balance=balance+$1 WHERE telegram_id=$2 RETURNING balance', [pay, req.tid]);
      await c.query(`UPDATE public.aviator_bets SET status='CASHED_OUT',cashout_multiplier=$1,payout=$2,settled_at=NOW() WHERE id=$3`, [m, pay, b.id]);
      await c.query(`INSERT INTO public.aviator_ledger(telegram_id,round_id,bet_id,entry_type,amount,balance_after) VALUES($1,$2,$3,'CASHOUT',$4,$5)`, [req.tid, a.id, b.id, pay, w.rows[0].balance]);
      await c.query('COMMIT'); res.json({ success: true, slot, multiplier: m, payout: pay, balance: Number(w.rows[0].balance) });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} console.error(e); res.status(500).json({ success: false, error: 'Cash Out failed' }); }
    finally { c.release(); }
  });
  return r;
};
