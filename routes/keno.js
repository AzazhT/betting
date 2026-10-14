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

    // የሙከራ የክፍያ ስሌት ብቻ፤ ኦፊሴላዊ የEthioLottery paytable አይደለም።
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
                round_id BIGINT NOT NULL
                    REFERENCES game_rounds(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
                picks JSONB NOT NULL,
                stake NUMERIC(12,2) NOT NULL,
                matched INTEGER NOT NULL DEFAULT 0,
                payout NUMERIC(12,2) NOT NULL DEFAULT 0,
                status VARCHAR(30) NOT NULL DEFAULT 'pending',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(round_id, user_id)
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_keno_tickets_round
            ON keno_tickets(round_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_keno_tickets_user
            ON keno_tickets(user_id);
        `);
    }

    async function createRoundIfNeeded() {
        const result = await pool.query(`
            SELECT id, round_number, status, created_at
            FROM game_rounds
            WHERE game = $1
              AND status IN ('open', 'drawing')
            ORDER BY id DESC
            LIMIT 1
        `, [GAME]);

        if (result.rows.length) {
            return result.rows[0];
        }

        const roundNumber = makeRoundNumber();

        const created = await pool.query(`
            INSERT INTO game_rounds (game, round_number, status)
            VALUES ($1, $2, 'open')
            RETURNING id, round_number, status, created_at
        `, [GAME, roundNumber]);

        return created.rows[0];
    }

    async function settleRound(roundId) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const roundResult = await client.query(`
                SELECT *
                FROM game_rounds
                WHERE id = $1 AND game = $2
                FOR UPDATE
            `, [roundId, GAME]);

            if (!roundResult.rows.length) {
                await client.query('ROLLBACK');
                return;
            }

            const round = roundResult.rows[0];

            // ሌላ scheduler ይህን ዙር ካስተናገደ ድጋሚ አይከፍልም።
            if (round.status !== 'open') {
                await client.query('ROLLBACK');
                return;
            }

            const ageMs = Date.now() - new Date(round.created_at).getTime();

            if (ageMs < BET_SECONDS * 1000) {
                await client.query('ROLLBACK');
                return;
            }

            const draw = makeDraw();
            const winningSet = new Set(draw);

            const tickets = await client.query(`
                SELECT *
                FROM keno_tickets
                WHERE round_id = $1 AND status = 'pending'
                FOR UPDATE
            `, [roundId]);

            for (const ticket of tickets.rows) {
                const picks = Array.isArray(ticket.picks)
                    ? ticket.picks
                    : JSON.parse(ticket.picks);

                const matched = picks.filter(n => winningSet.has(n)).length;
                const multiplier = getMultiplier(picks.length, matched);
                const payout = Math.round(
                    Number(ticket.stake) * multiplier * 100
                ) / 100;

                await client.query(`
                    UPDATE users
                    SET balance = balance + $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [payout, ticket.user_id]);

                await client.query(`
                    UPDATE keno_tickets
                    SET matched = $1,
                        payout = $2,
                        status = 'settled'
                    WHERE id = $3
                `, [matched, payout, ticket.id]);

                await client.query(`
                    UPDATE bets
                    SET actual_win = $1,
                        status = 'settled',
                        result = $2::jsonb,
                        settled_at = NOW()
                    WHERE id = $3
                `, [
                    payout,
                    JSON.stringify({
                        roundId,
                        picks,
                        draw,
                        matched,
                        multiplier
                    }),
                    ticket.bet_id
                ]);
            }

            // ውጤቱን በአንድ የጋራ ዙር ውስጥ እናስቀምጣለን።
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

            if (round.status === 'open') {
                const age = Date.now() - new Date(round.created_at).getTime();

                if (age >= BET_SECONDS * 1000) {
                    await settleRound(round.id);
                }
            } else if (round.status === 'drawing') {
                const age = Date.now() - new Date(round.closed_at).getTime();

                if (age >= DRAW_SECONDS * 1000) {
                    await pool.query(`
                        UPDATE game_rounds
                        SET status = 'closed'
                        WHERE id = $1 AND status = 'drawing'
                    `, [round.id]);

                    await createRoundIfNeeded();
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

    // የአሁኑን ዙርና ቆጣሪ ማየት
    router.get('/state', async (req, res) => {
        try {
            await ensureTables();
            const round = await createRoundIfNeeded();

            const fullRound = await pool.query(`
                SELECT id, round_number, status, created_at,
                       closed_at, result
                FROM game_rounds
                WHERE id = $1
            `, [round.id]);

            const r = fullRound.rows[0];
            const start = new Date(r.created_at).getTime();
            const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));

            const remaining = r.status === 'open'
                ? Math.max(0, BET_SECONDS - elapsed)
                : r.status === 'drawing'
                    ? Math.max(0, DRAW_SECONDS -
                        Math.floor((Date.now() - new Date(r.closed_at).getTime()) / 1000))
                    : 0;

            res.json({
                success: true,
                round: {
                    id: r.id,
                    number: r.round_number,
                    status: r.status,
                    remaining,
                    draw: r.result?.draw || []
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

    // ውርርድ ማስገባት፤ በዙሩ አንድ ትኬት ብቻ ለአንድ ተጠቃሚ
    router.post('/bet', async (req, res) => {
        const { picks, stake, telegram_id } = req.body || {};

        if (!telegram_id) {
            return res.status(400).json({
                success: false,
                error: 'Telegram ID ያስፈልጋል።'
            });
        }

        if (!validatePicks(picks)) {
            return res.status(400).json({
                success: false,
                error: 'ከ1 እስከ 80 ያሉ የተለያዩ ቁጥሮች ይምረጡ።'
            });
        }

        if (!validateStake(stake)) {
            return res.status(400).json({
                success: false,
                error: `ውርርድ ከ${MIN_STAKE} እስከ ${MAX_STAKE} ብር በ10 ብር እርምጃ ይሁን።`
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const userResult = await client.query(`
                SELECT id, balance
                FROM users
                WHERE telegram_id = $1 AND is_active = TRUE
                FOR UPDATE
            `, [String(telegram_id)]);

            if (!userResult.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    error: 'ተጠቃሚው አልተገኘም።'
                });
            }

            const user = userResult.rows[0];

            // በDB ውስጥ ያለውን ክፍት ዙር በመቆለፍ የጊዜ ውድድርን እንቀንሳለን።
            const roundResult = await client.query(`
                SELECT *
                FROM game_rounds
                WHERE game = $1 AND status = 'open'
                ORDER BY id DESC
                LIMIT 1
                FOR UPDATE
            `, [GAME]);

            if (!roundResult.rows.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    error: 'አሁን ውርርድ አይቻልም። አዲስ ዙር እየተዘጋጀ ነው።'
                });
            }

            const round = roundResult.rows[0];
            const elapsed = Date.now() - new Date(round.created_at).getTime();

            if (elapsed >= BET_SECONDS * 1000) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    error: 'የውርርድ ጊዜ አልቋል።'
                });
            }

            const amount = Number(stake);

            if (Number(user.balance) < amount) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    error: 'በቂ ባላንስ የለዎትም።'
                });
            }

            const alreadyBet = await client.query(`
                SELECT id FROM keno_tickets
                WHERE round_id = $1 AND user_id = $2
            `, [round.id, user.id]);

            if (alreadyBet.rows.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    error: 'በዚህ ዙር ውርርድ አስገብተዋል።'
                });
            }

            await client.query(`
                UPDATE users
                SET balance = balance - $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [amount, user.id]);

            const betResult = await client.query(`
                INSERT INTO bets
                    (user_id, game, stake, potential_win, status, result)
                VALUES ($1, $2, $3, 0, 'pending', $4::jsonb)
                RETURNING id
            `, [
                user.id,
                GAME,
                amount,
                JSON.stringify({ roundId: round.id, picks })
            ]);

            await client.query(`
                INSERT INTO keno_tickets
                    (round_id, user_id, picks, stake, status)
                VALUES ($1, $2, $3::jsonb, $4, 'pending')
            `, [
                round.id,
                user.id,
                JSON.stringify(picks),
                amount
            ]);

            await client.query('COMMIT');

            res.status(201).json({
                success: true,
                message: 'ውርርድዎ ተመዝግቧል።',
                roundId: round.id,
                balance: Number(user.balance) - amount
            });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Keno bet error:', err.message);

            if (err.code === '23505') {
                return res.status(409).json({
                    success: false,
                    error: 'በዚህ ዙር ውርርድ አስገብተዋል።'
                });
            }

            res.status(500).json({
                success: false,
                error: 'ውርርድ ማስገባት አልተቻለም።'
            });
        } finally {
            client.release();
        }
    });

    // የተጫዋቹ የቀድሞ ውርርዶችና ውጤቶች
    router.get('/history/:telegram_id', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    t.id,
                    t.picks,
                    t.stake,
                    t.matched,
                    t.payout,
                    t.status,
                    t.created_at,
                    r.round_number,
                    r.result
                FROM keno_tickets t
                JOIN users u ON u.id = t.user_id
                JOIN game_rounds r ON r.id = t.round_id
                WHERE u.telegram_id = $1
                ORDER BY t.id DESC
                LIMIT 50
            `, [String(req.params.telegram_id)]);

            res.json({ success: true, history: result.rows });
        } catch (err) {
            console.error('Keno history error:', err.message);
            res.status(500).json({
                success: false,
                error: 'ታሪክን ማግኘት አልተቻለም።'
            });
        }
    });

    startScheduler();

    return router;
};
