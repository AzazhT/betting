const express = require('express');
const crypto = require('crypto');

module.exports = function (pool) {
    const router = express.Router();

    const BET_SECONDS = 60;
    const DRAW_SECONDS = 20;
    const MIN_STAKE = 10;
    const MAX_STAKE = 1000;
    const MAX_PICKS = 10;
    const GAME = 'keno';

    const PAYTABLE = {
        1: { 1: 3.5 },
        2: { 2: 10 },
        3: { 3: 35 },
        4: { 4: 100 },
        5: { 5: 250 },
        6: { 6: 600 },
        7: { 7: 1500 },
        8: { 8: 4000 },
        9: { 9: 10000 },
        10: { 10: 25000 }
    };

    let schedulerStarted = false;
    let schedulerBusy = false;

    function makeRoundNumber() {
        return `KENO-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    }

    function makeDraw() {
        const numbers = new Set();
        while (numbers.size < 20) {
            numbers.add(crypto.randomInt(1, 81));
        }
        return [...numbers];
    }

    function getMultiplier(pickCount, matchCount) {
        return Number(PAYTABLE[pickCount]?.[matchCount] || 0);
    }

    function validatePicks(picks) {
        return Array.isArray(picks) &&
            picks.length >= 1 &&
            picks.length <= MAX_PICKS &&
            picks.every(n => Number.isInteger(n) && n >= 1 && n <= 80) &&
            new Set(picks).size === picks.length;
    }

    function validateStake(stake) {
        const amount = Number(stake);
        return Number.isFinite(amount) &&
            amount >= MIN_STAKE &&
            amount <= MAX_STAKE &&
            Number.isInteger(amount) &&
            amount % 10 === 0;
    }

    async function ensureTables() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS keno_tickets (
                id BIGSERIAL PRIMARY KEY,
                round_id BIGINT NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                picks JSONB NOT NULL,
                stake NUMERIC(12,2) NOT NULL,
                matched INTEGER NOT NULL DEFAULT 0,
                payout NUMERIC(12,2) NOT NULL DEFAULT 0,
                status VARCHAR(30) NOT NULL DEFAULT 'pending',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(round_id, user_id)
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_keno_tickets_round ON keno_tickets(round_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_keno_tickets_user ON keno_tickets(user_id);`);
    }

    async function createRoundIfNeeded() {
        let result = await pool.query(`
            SELECT id, round_number, status, created_at, closed_at, result
            FROM game_rounds
            WHERE game = $1
              AND status IN ('open', 'drawing', 'settled')
            ORDER BY id DESC
            LIMIT 1
        `, [GAME]);

        if (result.rows.length) {
            const r = result.rows[0];
            const now = Date.now();
            const elapsed = Math.floor((now - new Date(r.created_at).getTime()) / 1000);

            if (r.status === 'open' && elapsed >= BET_SECONDS) {
                await settleRound(r.id);
                const nextRes = await pool.query(`
                    SELECT id, round_number, status, created_at, closed_at, result
                    FROM game_rounds
                    WHERE game = $1
                    ORDER BY id DESC
                    LIMIT 1
                `, [GAME]);
                return nextRes.rows[0];
            }
            return r;
        }

        const roundNumber = makeRoundNumber();
        const created = await pool.query(`
            INSERT INTO game_rounds (game, round_number, status)
            VALUES ($1, $2, 'open')
            RETURNING id, round_number, status, created_at, closed_at, result
        `, [GAME, roundNumber]);

        return created.rows[0];
    }

    async function settleRound(roundId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const roundResult = await client.query(`
                SELECT * FROM game_rounds WHERE id = $1 AND game = $2 FOR UPDATE
            `, [roundId, GAME]);

            if (!roundResult.rows.length) {
                await client.query('ROLLBACK');
                return;
            }

            const round = roundResult.rows[0];
            if (round.status !== 'open') {
                await client.query('ROLLBACK');
                return;
            }

            const draw = makeDraw();
            const winningSet = new Set(draw);

            const tickets = await client.query(`
                SELECT * FROM keno_tickets WHERE round_id = $1 AND status = 'pending' FOR UPDATE
            `, [roundId]);

            for (const ticket of tickets.rows) {
                const picks = Array.isArray(ticket.picks) ? ticket.picks : JSON.parse(ticket.picks);
                const matched = picks.filter(n => winningSet.has(n)).length;
                const multiplier = getMultiplier(picks.length, matched);
                const payout = Math.round(Number(ticket.stake) * multiplier * 100) / 100;

                if (payout > 0) {
                    await client.query(`
                        UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2
                    `, [payout, ticket.user_id]);
                }

                await client.query(`
                    UPDATE keno_tickets SET matched = $1, payout = $2, status = 'settled' WHERE id = $3
                `, [matched, payout, ticket.id]);
            }

            await client.query(`
                UPDATE game_rounds
                SET status = 'drawing',
                    result = $1::jsonb,
                    closed_at = NOW()
                WHERE id = $2
            `, [JSON.stringify({ draw }), roundId]);

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Keno settlement error:', err);
        } finally {
            client.release();
        }
    }

    async function schedulerTick() {
        if (schedulerBusy) return;
        schedulerBusy = true;

        try {
            const round = await createRoundIfNeeded();

            if (round && round.status === 'open') {
                const age = Date.now() - new Date(round.created_at).getTime();
                if (age >= BET_SECONDS * 1000) {
                    await settleRound(round.id);
                }
            } else if (round && round.status === 'drawing') {
                const closedTime = round.closed_at ? new Date(round.closed_at).getTime() : Date.now();
                const age = Date.now() - closedTime;
                if (age >= DRAW_SECONDS * 1000) {
                    const roundNumber = makeRoundNumber();
                    await pool.query(`
                        INSERT INTO game_rounds (game, round_number, status)
                        VALUES ($1, $2, 'open')
                    `, [GAME, roundNumber]);
                }
            }
        } catch (err) {
            console.error('Keno scheduler error:', err.message);
        } finally {
            schedulerBusy = false;
        }
    }

    function startScheduler() {
        if (schedulerStarted) return;
        schedulerStarted = true;

        ensureTables()
            .then(() => schedulerTick())
            .catch(err => console.error('Keno startup error:', err));

        setInterval(schedulerTick, 1000);
    }

    router.get('/state', async (req, res) => {
        try {
            await ensureTables();
            const round = await createRoundIfNeeded();

            const start = new Date(round.created_at).getTime();
            const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));

            let remaining = 60;
            let status = round.status;

            if (status === 'open') {
                remaining = Math.max(0, BET_SECONDS - elapsed);
                if (remaining === 0) {
                    await settleRound(round.id);
                    status = 'drawing';
                    remaining = DRAW_SECONDS;
                }
            } else if (status === 'drawing' || status === 'settled') {
                const closedTime = round.closed_at ? new Date(round.closed_at).getTime() : start;
                const drawElapsed = Math.floor((Date.now() - closedTime) / 1000);
                remaining = Math.max(0, DRAW_SECONDS - drawElapsed);
                if (remaining === 0 && status === 'drawing') {
                    status = 'settled';
                }
            }

            res.json({
                success: true,
                round: {
                    id: round.id,
                    number: round.round_number,
                    status: status,
                    remaining,
                    draw: round.result?.draw || []
                }
            });
        } catch (err) {
            console.error('Keno state error:', err.message);
            res.status(500).json({
                success: false,
                error: 'የጨዋታውን ሁኔታ ማግኘት አልተቻለም።'
            });
        }
    });

    router.post('/bet', async (req, res) => {
        const { picks, stake, telegram_id, round_id } = req.body || {};

        if (!telegram_id) {
            return res.status(400).json({ success: false, error: 'Telegram ID ያስፈልጋል።' });
        }
        if (!validatePicks(picks)) {
            return res.status(400).json({ success: false, error: 'ከ1 እስከ 80 ያሉ የተለያዩ ቁጥሮች ይምረጡ።' });
        }
        if (!validateStake(stake)) {
            return res.status(400).json({ success: false, error: 'ትክክለኛ የውርርድ መጠን ያስገቡ።' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const userResult = await client.query(`
                SELECT id, balance FROM users WHERE telegram_id = $1 FOR UPDATE
            `, [String(telegram_id)]);

            if (!userResult.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'ተጠቃሚው አልተገኘም።' });
            }

            const user = userResult.rows[0];

            const roundResult = await client.query(`
                SELECT * FROM game_rounds WHERE game = $1 AND status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE
            `, [GAME]);

            if (!roundResult.rows.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({ success: false, error: 'አሁን ውርርድ አይቻልም። ዙሩ ተዘግቷል።' });
            }

            const round = roundResult.rows[0];
            const amount = Number(stake);

            if (Number(user.balance) < amount) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'በቂ ባላንስ የለዎትም።' });
            }

            const alreadyBet = await client.query(`
                SELECT id FROM keno_tickets WHERE round_id = $1 AND user_id = $2
            `, [round.id, user.id]);

            if (alreadyBet.rows.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({ success: false, error: 'በዚህ ዙር ውርርድ አስገብተዋል።' });
            }

            await client.query(`
                UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2
            `, [amount, user.id]);

            const ticketRes = await client.query(`
                INSERT INTO keno_tickets (round_id, user_id, picks, stake, status)
                VALUES ($1, $2, $3::jsonb, $4, 'pending')
                RETURNING id
            `, [round.id, user.id, JSON.stringify(picks), amount]);

            await client.query('COMMIT');

            res.status(201).json({
                success: true,
                message: 'ውርርድዎ ተመዝግቧል።',
                ticket: { id: ticketRes.rows[0].id },
                balance: Number(user.balance) - amount
            });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Keno bet error:', err.message);
            res.status(500).json({ success: false, error: 'ውርርድ ማስገባት አልተቻለም።' });
        } finally {
            client.release();
        }
    });

    router.get('/history/:telegram_id', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT t.id, t.picks, t.stake, t.matched, t.payout, t.status, t.created_at, r.round_number, r.result
                FROM keno_tickets t
                JOIN users u ON u.id = t.user_id
                JOIN game_rounds r ON r.id = t.round_id
                WHERE u.telegram_id = $1
                ORDER BY t.id DESC
                LIMIT 50
            `, [String(req.params.telegram_id)]);

            res.json({ success: true, history: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: 'ታሪክን ማግኘት አልተቻለም።' });
        }
    });

    startScheduler();
    return router;
};
```[cite: 3]

---

### 2. የፊት ገጽ ፋይል (`public/keno.html`)

ይህንን ኮድ ሙሉ በሙሉ ኮፒ አድርገው በፕሮጀክትዎ ውስጥ ባለው `public/keno.html` ፋይል ላይ ይለጥፉት[cite: 2, 3]:

```html
<!DOCTYPE html>
<html lang="am">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#10120f">
  <title>Fast Keno - እድል ኬኖ</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root{--bg:#10120f;--panel:#1b1e19;--panel2:#242821;--muted:#92988d;--text:#f7f8f4;--gold:#e6b947;--green:#6ea54e;--line:#30352c;--red:#e5484d}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding-bottom:24px}button{font:inherit}
    .app{width:min(100%,520px);margin:auto;padding:12px 12px calc(24px + env(safe-area-inset-bottom))}
    .topbar,.wallet,.section-head,.stake-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .topbar{margin-bottom:12px}.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text)}.logo{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--gold);color:#17150e;font-weight:900;font-size:18px}.brand strong{display:block;font-size:15px}.brand small{color:var(--muted);font-size:11px}
    .home{color:var(--gold);text-decoration:none;font-weight:800;font-size:12px}
    .wallet{background:linear-gradient(115deg,#252a20,#1a1d18);border:1px solid #34392f;border-radius:15px;padding:11px 13px;margin-bottom:12px}.wallet small{color:var(--muted);display:block}.wallet strong{font-size:19px;color:var(--gold)}.wallet .add{border:0;border-radius:10px;padding:9px 12px;background:var(--gold);font-weight:800;color:#1a170e}
    .game-card,.tickets-card{border:1px solid var(--line);background:var(--panel);border-radius:16px;padding:12px;margin-bottom:12px}.section-head{margin-bottom:9px}.section-head h2{margin:0;font-size:15px}.pill{border-radius:20px;padding:5px 9px;background:#292e25;color:var(--gold);font-size:11px;font-weight:800;white-space:nowrap}
    .draw-area{position:relative;min-height:142px;border-radius:14px;background:radial-gradient(ellipse at center,#263022 0%,#171c15 70%,#10120f 100%);border:1px solid #343a2e;padding:12px 9px 10px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:9px;margin-bottom:12px;overflow:hidden}
    .draw-counter{position:absolute;top:8px;right:10px;color:var(--gold);font-size:11px;font-weight:900}.draw-status{position:absolute;top:8px;left:10px;color:var(--muted);font-size:10px;font-weight:700}
    .empty-draw{text-align:center;color:var(--muted);padding-top:7px}.empty-draw b{color:var(--gold);display:block;font-size:17px;margin-bottom:3px}.empty-draw span{font-size:12px}
    .current-ball-container{display:flex;justify-content:center;align-items:center;min-height:54px}
    .draw-ball-large{width:50px;height:50px;border-radius:50%;display:grid;place-items:center;color:#17150e;font-weight:950;font-size:18px;background:radial-gradient(circle at 30% 25%,#fff1ab,#e6b947 62%,#aa7720);box-shadow:0 4px 18px #e6b94777;animation:pop .32s ease-out both;border:2px solid #f4d67b}
    .drawn-balls-row{display:flex;flex-wrap:wrap;justify-content:center;gap:4px;max-width:100%;min-height:26px}
    .small-ball{width:25px;height:25px;border-radius:50%;display:grid;place-items:center;color:#dce3d5;font-weight:800;font-size:10px;background:#252c20;border:1px solid #3d4734}
    .small-ball.active{background:radial-gradient(circle at 30% 25%,#fff1ab,#e6b947 62%,#aa7720);color:#17150e;border-color:#f2ce6e}
    .small-ball.match{background:var(--green);color:#fff;border-color:#b0e28a;box-shadow:0 0 8px #6ea54e88}
    @keyframes pop{from{transform:scale(.2) translateY(-10px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
    .grid{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:5px;margin:10px 0 13px}
    .number{aspect-ratio:1;border-radius:8px;border:1px solid #363b32;color:#d6d9d1;background:#252922;font-weight:750;cursor:pointer;padding:0;font-size:clamp(11px,3vw,13px);min-width:0}
    .number.selected{color:#17150e;background:var(--gold);border-color:#f2ce6e;box-shadow:0 0 8px #e6b94733}
    .number.winning{color:#fff;background:var(--green);border-color:#a5d480}
    .number.match{color:#fff;background:linear-gradient(145deg,#8bc764,#427b30);border:2px solid #d4ffac;box-shadow:0 0 10px #6ea54e99}
    .number:disabled{cursor:not-allowed;opacity:.94}
    .legend{display:flex;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:10px;margin:-5px 0 12px}.legend span{display:flex;align-items:center;gap:4px}.dot{width:9px;height:9px;border-radius:3px;display:inline-block}.dot.gold{background:var(--gold)}.dot.green{background:var(--green)}.dot.match{background:#8bc764;border:1px solid #d4ffac}
    .stake-row{margin-bottom:10px;flex-wrap:wrap}.stake-label{color:var(--muted);margin-right:auto}.stake-control{display:flex;align-items:center;gap:5px;background:var(--panel2);border-radius:10px;padding:4px}.stake-control button,.quick-btn{border:0;color:var(--text);background:#34392f;border-radius:8px;padding:7px 9px;cursor:pointer}.stake-control strong{min-width:66px;text-align:center;color:var(--gold);font-size:12px}.quick-btn{color:var(--gold);font-weight:800}
    .bet-btn{width:100%;border:0;border-radius:12px;padding:13px;color:#1b170b;background:var(--gold);font-weight:950;letter-spacing:.04em;cursor:pointer}.bet-btn:disabled{opacity:.55;cursor:not-allowed}
    .subnote{color:var(--muted);font-size:11px;margin-top:8px;text-align:center}
    .tabs{display:flex;gap:5px;padding:5px;background:var(--panel);border:1px solid var(--line);border-radius:13px;margin-bottom:12px}.tab{flex:1;border:0;border-radius:9px;padding:9px 2px;color:var(--muted);background:transparent;font-size:11px;font-weight:800;cursor:pointer}.tab.active{color:#1b170b;background:var(--gold)}
    .ticket-item{background:#151814;border:1px solid #2b3028;border-radius:10px;padding:10px;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}.ticket-top{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}.ticket-picks{display:flex;gap:4px;flex-wrap:wrap}.pick-ball{width:25px;height:25px;border-radius:6px;background:#2a3026;display:grid;place-items:center;font-size:10px;font-weight:800;color:var(--gold);border:1px solid #3b4233}.pick-ball.matched{background:var(--green);color:#fff;border-color:#8ce264;box-shadow:0 0 8px #6ea54eaa;font-weight:950}.ticket-bottom{display:flex;justify-content:space-between;align-items:center;margin-top:3px}.ticket-stake{font-weight:800;font-size:12px}.status{font-weight:800;font-size:11px}.status.waiting{color:var(--gold)}.status.won{color:var(--green)}.status.lost{color:var(--red)}.empty-list{padding:15px 0;text-align:center;color:var(--muted);font-size:12px}
    .notice{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);width:max-content;max-width:calc(100% - 28px);background:#f4f1e7;color:#1b1d18;border-radius:10px;padding:10px 14px;box-shadow:0 6px 25px #0008;opacity:0;pointer-events:none;transition:opacity .2s;z-index:1000;font-weight:750;font-size:12px;text-align:center}.notice.show{opacity:1}.notice.error{background:#e5484d;color:#fff}
    .hidden{display:none!important}
  </style>
</head>
<body>
<main class="app">
  <header class="topbar">
    <a href="/" class="brand"><div class="logo">K</div><div><strong>FAST KENO</strong><small>Ethio Lottery Style</small></div></a>
    <a href="/" class="home">🏠 መነሻ</a>
  </header>

  <section class="wallet">
    <div><small id="playerInfo">PLAYER · በመጫን ላይ...</small><strong class="wallet-balance">0.00 ETB</strong></div>
    <button class="add" id="addFunds" type="button">＋ ዋሌት</button>
  </section>

  <section class="game-card">
    <div class="section-head">
      <h2 id="gameTitle">ቁጥሮችዎን ይምረጡ</h2>
      <span class="pill" id="roundTimer">60 ሰከንድ</span>
    </div>

    <div class="draw-area" id="drawArea">
      <div class="draw-status" id="drawStatus">BETTING OPEN</div>
      <div class="draw-counter" id="drawCounter">0 / 20</div>
      <div class="empty-draw" id="drawPlaceholder"><b>Fast Keno</b><span>እስከ 10 ቁጥሮች ይምረጡ</span></div>
      <div class="current-ball-container" id="currentBallContainer"></div>
      <div class="drawn-balls-row" id="drawnBallsRow"></div>
    </div>

    <div class="section-head">
      <h2>ቁጥር መምረጫ</h2>
      <span class="pill"><span id="selectedCount">0</span> / 10 ተመርጠዋል</span>
    </div>
    <div class="grid" id="numberGrid"></div>
    <div class="legend">
      <span><i class="dot gold"></i> የመረጥከው</span>
      <span><i class="dot green"></i> የወጣ</span>
      <span><i class="dot match"></i> የተገጠመ</span>
    </div>

    <div class="stake-row">
      <span class="stake-label">ውርርድ (Stake)</span>
      <div class="stake-control"><button id="minus" type="button">−</button><strong id="stakeAmount">10.00 ETB</strong><button id="plus" type="button">＋</button></div>
      <button class="quick-btn" id="double" type="button">×2</button>
      <button class="quick-btn" id="max" type="button">MAX</button>
    </div>
    <button class="bet-btn" id="betButton" type="button">BET · 10.00 ETB</button>
    <div class="subnote" id="roundNote">ውርርድዎ ከዙሩ መዘጋት በፊት ይመዝገብ።</div>
  </section>

  <nav class="tabs" aria-label="Main navigation">
    <button class="tab active" data-tab="GAME" type="button">ጨዋታ</button>
    <button class="tab" data-tab="HISTORY" type="button">ታሪክ</button>
    <button class="tab" data-tab="RESULTS" type="button">ውጤቶች</button>
  </nav>
  <section class="tickets-card" id="historyCard">
    <div class="section-head"><h2 id="listTitle">የእኔ ቲኬቶች</h2><span class="pill" id="ticketCount">0</span></div>
    <div id="ticketList"><div class="empty-list">እስካሁን ቲኬት የለም</div></div>
  </section>
</main>
<div class="notice" id="notice" role="status" aria-live="polite"></div>

<script>
(() => {
  "use strict";
  const CONFIG = { maxPicks:10, minStake:10, stakeStep:10, maxStake:1000, currency:"ETB", pollMs:1000, revealMs:800 };
  const $ = (s, r=document) => r.querySelector(s); const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const el = {
    grid:$("#numberGrid"), timer:$("#roundTimer"), title:$("#gameTitle"), drawStatus:$("#drawStatus"),
    drawCounter:$("#drawCounter"), placeholder:$("#drawPlaceholder"), currentBall:$("#currentBallContainer"),
    drawn:$("#drawnBallsRow"), selectedCount:$("#selectedCount"), stakeAmount:$("#stakeAmount"),
    bet:$("#betButton"), playerInfo:$("#playerInfo"), wallet:$(".wallet-balance"), notice:$("#notice"),
    ticketList:$("#ticketList"), ticketCount:$("#ticketCount"), listTitle:$("#listTitle"), note:$("#roundNote")
  };
  const tg = window.Telegram?.WebApp;
  const tgUser = tg?.initDataUnsafe?.user;
  const qs = new URLSearchParams(location.search);
  const telegramId = tgUser?.id ? String(tgUser.id) : (qs.get("telegram_id") || localStorage.getItem("keno_telegram_id") || "");
  const state = {
    telegramId, name:tgUser?.first_name || "Player", balance:0, picks:new Set(), stake:10,
    roundId:null, roundNumber:null, roundStatus:"open", remaining:60, draw:[], shownDraw:[],
    ticketThisRound:null, tickets:[], hasBet:false, busy:false, tab:"GAME"
  };
  let noticeTimer = null, pollTimer = null, revealTimer = null, revealToken = 0;

  function money(v){ const n=Number(v); return `${(Number.isFinite(n)?n:0).toFixed(2)} ${CONFIG.currency}`; }
  function notice(msg, error=false){
    el.notice.textContent=msg; el.notice.classList.toggle("error",error); el.notice.classList.add("show");
    clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>el.notice.classList.remove("show","error"),2800);
  }
  async function api(url, options={}){
    const res=await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
    let data={}; try{data=await res.json();}catch{}
    if(!res.ok || data.success===false) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
  }
  function updateWallet(value){ state.balance=Number(value)||0; el.wallet.textContent=money(state.balance); }
  function renderGrid(){
    el.grid.replaceChildren();
    for(let n=1;n<=80;n++){
      const b=document.createElement("button"); b.type="button"; b.className="number"; b.textContent=String(n); b.dataset.number=n;
      b.addEventListener("click",()=>togglePick(n)); el.grid.appendChild(b);
    }
    syncGrid();
  }
  function togglePick(n){
    if(!canChoose()){notice("የመምረጫ ጊዜው አልቋል። ቀጣዩን ዙር ይጠብቁ።",true);return;}
    if(state.hasBet){notice("ቲኬቱ ተመዝግቧል፤ ቁጥሮቹን መቀየር አይቻልም።",true);return;}
    if(state.picks.has(n)) state.picks.delete(n);
    else { if(state.picks.size>=CONFIG.maxPicks){notice("እስከ 10 ቁጥሮች ብቻ መምረጥ ይችላሉ።",true);return;} state.picks.add(n); }
    syncGrid();
  }
  function syncGrid(){
    $$(".number",el.grid).forEach(b=>{
      const n=Number(b.dataset.number), selected=state.picks.has(n), drawn=state.shownDraw.includes(n), matched=selected&&drawn;
      b.classList.toggle("selected",selected&&!matched); b.classList.toggle("winning",drawn&&!matched); b.classList.toggle("match",matched);
      b.disabled=!canChoose() || state.hasBet;
    });
    el.selectedCount.textContent=state.picks.size;
  }
  function canChoose(){ return state.roundStatus==="open" && state.remaining>0 && !state.busy; }
  function setStake(v){
    if(!canChoose()||state.hasBet)return;
    const n=Math.floor(Number(v)||CONFIG.minStake);
    state.stake=Math.min(CONFIG.maxStake,Math.max(CONFIG.minStake,Math.round(n/CONFIG.stakeStep)*CONFIG.stakeStep));
    el.stakeAmount.textContent=money(state.stake); el.bet.textContent=`BET · ${money(state.stake)}`;
  }
  function renderDraw(){
    const draw=state.shownDraw;
    el.drawn.replaceChildren();
    draw.forEach(n=>{
      const b=document.createElement("div"); b.className="small-ball"+(state.picks.has(n)?" match":" active"); b.textContent=String(n).padStart(2,"0"); el.drawn.appendChild(b);
    });
    el.drawCounter.textContent=`${draw.length} / 20`;
    if(draw.length){
      el.placeholder.classList.add("hidden");
      el.currentBall.innerHTML=`<div class="draw-ball-large">${draw[draw.length-1]}</div>`;
    }else{
      el.currentBall.replaceChildren();
      if(state.roundStatus==="open") el.placeholder.classList.remove("hidden");
    }
    syncGrid();
    renderTickets();
  }
  function updateStatus(){
    const open=canChoose();
    if(state.roundStatus==="open"){
      el.drawStatus.textContent="BETTING OPEN";
      el.timer.textContent=`${Math.max(0,state.remaining)} ሰከንድ`;
      el.title.textContent="ቁጥሮችዎን ይምረጡ";
      el.note.textContent=state.hasBet?"ቲኬትዎ ተመዝግቧል፤ ውጤቱን ይጠብቁ።":"60 ሰከንድ የመምረጫ ጊዜ። ጊዜው ሲያበቃ ውርርድ ይዘጋል።";
      el.bet.disabled=!open||state.hasBet||state.picks.size===0||state.stake>state.balance||state.busy;
      el.bet.textContent=state.hasBet?"ተመዝግቧል (Waiting)":`BET · ${money(state.stake)}`;
    }else{
      el.drawStatus.textContent=state.roundStatus==="drawing"?"LIVE DRAW":"ROUND COMPLETE";
      el.timer.textContent=state.roundStatus==="drawing"?`${state.shownDraw.length}/20 የወጡ`:"ተጠናቋል";
      el.title.textContent=state.roundStatus==="drawing"?"ቁጥሮች እየወጡ ነው":"የዙር ውጤት";
      el.note.textContent=state.roundStatus==="drawing"?"የወጡት ቁጥሮች ለሁሉም ተጫዋቾች አንድ ናቸው።":"ቀጣዩ ዙር ሲከፈት እንደገና መምረጥ ይችላሉ።";
      el.bet.disabled=true; el.bet.textContent=state.roundStatus==="drawing"?"ውጤት እየወጣ ነው…":"ውርርድ ተዘግቷል";
    }
    syncGrid();
  }
  async function loadWallet(){
    if(!state.telegramId){el.playerInfo.textContent="PLAYER · Telegram ያስፈልጋል";return;}
    try{
      const data=await api(`/api/wallet/balance/${encodeURIComponent(state.telegramId)}`);
      const u=data.user||data;
      if(u.balance!==undefined) updateWallet(u.balance);
      if(u.name)state.name=u.name;
      el.playerInfo.textContent=`PLAYER · ${state.name}`;
    }catch(e){
      el.playerInfo.textContent=`PLAYER · ${state.name}`;
    }
  }
  function animateToDraw(draw){
    const token=++revealToken;
    const target=draw.slice(0,20);
    if(revealTimer) return;
    revealTimer=setInterval(()=>{
      if(token!==revealToken){ clearInterval(revealTimer); revealTimer=null; return; }
      if(state.shownDraw.length>=target.length){
        clearInterval(revealTimer); revealTimer=null;
        return;
      }
      state.shownDraw.push(target[state.shownDraw.length]);
      renderDraw();
    },CONFIG.revealMs);
  }
  async function refreshState(){
    try{
      const data=await api("/api/keno/state");
      const r=data.round||data;
      const nextId=r.id;
      const nextStatus=String(r.status||"open").toLowerCase();
      const nextRemaining=Number(r.remaining||60);
      const nextDraw=Array.isArray(r.draw)?r.draw.map(Number):[];

      const changed=String(nextId)!==String(state.roundId);
      if(changed){
        clearInterval(revealTimer); revealTimer=null; revealToken++;
        state.roundId=nextId;
        state.roundNumber=r.number;
        state.picks.clear();
        state.hasBet=false;
        state.ticketThisRound=null;
        state.shownDraw=[];
        state.busy=false;
      }

      state.roundStatus=nextStatus;
      state.remaining=nextRemaining;
      state.draw=nextDraw;

      if(nextStatus==="drawing" || nextStatus==="settled"){
        if(nextDraw.length && state.shownDraw.length < nextDraw.length){
          animateToDraw(nextDraw);
        }
      } else if(nextStatus==="open"){
        if(state.shownDraw.length > 0 && changed){
          state.shownDraw=[];
          el.currentBall.replaceChildren();
          el.drawn.replaceChildren();
          el.placeholder.classList.remove("hidden");
        }
      }
      renderDraw(); updateStatus();
    }catch(e){
      el.drawStatus.textContent="SERVER CONNECTION";
      el.note.textContent="ሰርቨሩን ማግኘት አልተቻለም፤ እንደገና እየሞከርን ነው።";
    }
  }
  async function placeBet(){
    if(!state.telegramId){notice("እባክዎ ጨዋታውን ከTelegram ይክፈቱ።",true);return;}
    if(!canChoose()){notice("የመምረጫ ጊዜው አልቋል።",true);return;}
    if(state.hasBet){notice("ለዚህ ዙር ቲኬት አስቀድመው መዝግበዋል።",true);return;}
    if(state.picks.size<1){notice("እባክዎ ቢያንስ 1 ቁጥር ይምረጡ።",true);return;}
    if(state.stake>state.balance){notice("በዋሌትዎ ውስጥ በቂ ብር የለም።",true);return;}
    state.busy=true; updateStatus();
    try{
      const data=await api("/api/keno/bet",{method:"POST",body:JSON.stringify({picks:[...state.picks].sort((a,b)=>a-b),stake:state.stake,telegram_id:state.telegramId,round_id:state.roundId})});
      state.hasBet=true;
      const result=data.ticket||data.bet||data;
      state.ticketThisRound={picks:[...state.picks].sort((a,b)=>a-b),stake:state.stake,status:"Waiting",round_number:state.roundNumber,id:result.id};
      if(data.balance!==undefined)updateWallet(data.balance); else await loadWallet();
      notice("ውርርድዎ በሰርቨሩ ላይ ተመዝግቧል።");
      await loadHistory();
    }catch(e){notice(e.message||"ውርርዱ አልተመዘገበም።",true);}
    finally{state.busy=false;updateStatus();}
  }
  async function loadHistory(){
    if(!state.telegramId)return;
    try{
      const data=await api(`/api/keno/history/${encodeURIComponent(state.telegramId)}`);
      const list=Array.isArray(data)?data:(data.history||data.tickets||data.bets||[]);
      state.tickets=list;
      renderTickets();
    }catch(e){}
  }
  function renderTickets(){
    const items=state.tickets.slice(0,15);
    if(state.ticketThisRound && !items.some(t=>String(t.id)===String(state.ticketThisRound.id))) items.unshift(state.ticketThisRound);
    el.ticketCount.textContent=items.length;
    el.ticketList.replaceChildren();
    if(!items.length){el.ticketList.innerHTML='<div class="empty-list">እስካሁን ቲኬት የለም</div>';return;}
    items.forEach(t=>{
      const picks=Array.isArray(t.picks)?t.picks:(Array.isArray(t.selected_numbers)?t.selected_numbers:[]);
      const stake=Number(t.stake??t.amount??0);
      const payout=Number(t.payout??t.actual_win??0);
      const raw=String(t.status||"waiting").toLowerCase();
      const status=raw==="won"||raw==="win"||payout>0?"Won":raw==="lost"||raw==="lose"?"Lost":"Waiting";
      const row=document.createElement("div");row.className="ticket-item";
      const top=document.createElement("div");top.className="ticket-top";
      const round=t.round_number??t.round_id??"—";
      const badge=document.createElement("span");badge.className=`status ${status.toLowerCase()}`;badge.textContent=status==="Won"?"አሸንፈዋል":status==="Lost"?"አልተሳካም":"በመጠበቅ ላይ";
      const roundLabel=document.createElement("span");roundLabel.textContent=`ዙር ${round}`;top.append(roundLabel,badge);
      const pickRow=document.createElement("div");pickRow.className="ticket-picks";
      picks.forEach(n=>{
        const numVal = Number(n);
        const isMatched = state.shownDraw.includes(numVal);
        const b=document.createElement("div");
        b.className="pick-ball"+(isMatched?" matched":"");
        b.textContent=String(numVal).padStart(2,"0");
        pickRow.appendChild(b);
      });
      const bottom=document.createElement("div");bottom.className="ticket-bottom";
      const st=document.createElement("span");st.className="ticket-stake";st.textContent=`ውርርድ ${money(stake)}`;
      const win=document.createElement("span");win.className="ticket-stake";win.style.color=payout>0?"var(--green)":"var(--muted)";win.textContent=`ክፍያ ${money(payout)}`;
      bottom.append(st,win);row.append(top,pickRow,bottom);el.ticketList.appendChild(row);
    });
  }
  function bind(){
    el.bet.addEventListener("click",placeBet);
    $("#minus").addEventListener("click",()=>setStake(state.stake-CONFIG.stakeStep));
    $("#plus").addEventListener("click",()=>setStake(state.stake+CONFIG.stakeStep));
    $("#double").addEventListener("click",()=>setStake(state.stake*2));
    $("#max").addEventListener("click",()=>setStake(Math.min(CONFIG.maxStake,Math.floor(state.balance/CONFIG.stakeStep)*CONFIG.stakeStep)));
    $("#addFunds").addEventListener("click",()=>{location.href="/";});
    $$(".tab").forEach(b=>b.addEventListener("click",()=>{ state.tab=b.dataset.tab; $$
(".tab").forEach(x=>x.classList.toggle("active",x===b));
      el.listTitle.textContent=state.tab==="HISTORY"?"የውርርድ ታሪክ":state.tab==="RESULTS"?"የዙር ውጤቶች":"የእኔ ቲኬቶች";
      loadHistory();
    }));
  }
  async function init(){
    if(tg){tg.ready();tg.expand();}
    if(!state.telegramId) el.playerInfo.textContent="PLAYER · Telegram ያስፈልጋል";
    renderGrid();bind();setStake(10);await loadWallet();await refreshState();await loadHistory();
    pollTimer=setInterval(async()=>{await refreshState();await loadWallet();},CONFIG.pollMs);
    setInterval(loadHistory,8000);
  }
  document.readyState==="loading"?document.addEventListener("DOMContentLoaded",init,{once:true}):init();
})();
</script>
</body>
</html>
```[cite: 2, 3]
