const express = require('express');

module.exports = function(pool, io) {
    const router = express.Router();

    // የተሟላ የኬኖ Paytable (ማባዣዎች)
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

    let currentRound = {
        roundId: Date.now(),
        timeLeft: 30, // 30 ሰከንድ የውርርድ ጊዜ
        status: 'BETTING', // BETTING ወይም DRAWING
        winningDraw: []
    };

    // በሰርቨር በኩል በየ 1 ሰከንዱ የሚቆጠር እና ሁሉንም ተጫዋቾች የሚያመሳስል ሰዓት ቆጣሪ
    setInterval(async () => {
        if (currentRound.status === 'BETTING') {
            currentRound.timeLeft--;

            if (io) {
                io.emit('round_update', {
                    roundId: currentRound.roundId,
                    timeLeft: currentRound.timeLeft,
                    status: currentRound.status
                });
            }

            // 30 ሰከንዱ ሲያልቅ ወደ ድራው (DRAWING) ይገባል
            if (currentRound.timeLeft <= 0) {
                currentRound.status = 'DRAWING';
                currentRound.timeLeft = 20; // 20 ሰከንድ ለቀጥታ ድራው አኒሜሽን

                // 20 የዘፈቀደ ቁጥሮች ማውጣት
                let draw = [];
                while (draw.length < 20) {
                    let r = Math.floor(Math.random() * 80) + 1;
                    if (!draw.includes(r)) draw.push(r);
                }
                currentRound.winningDraw = draw;

                // የዚህን ዙር ውርርዶች አረጋግጦ አሸናፊዎችን መክፈል
                await processRoundPayouts(currentRound.roundId, draw);

                if (io) {
                    io.emit('draw_started', {
                        roundId: currentRound.roundId,
                        draw: draw,
                        timeLeft: currentRound.timeLeft,
                        status: currentRound.status
                    });
                }
            }
        } else if (currentRound.status === 'DRAWING') {
            currentRound.timeLeft--;

            if (io) {
                io.emit('round_update', {
                    roundId: currentRound.roundId,
                    timeLeft: currentRound.timeLeft,
                    status: currentRound.status
                });
            }

            // 20 ሰከንዱ ሲያልቅ አዲስ ዙር (BETTING) ይጀምራል
            if (currentRound.timeLeft <= 0) {
                currentRound.roundId = Date.now();
                currentRound.status = 'BETTING';
                currentRound.timeLeft = 30;
                currentRound.winningDraw = [];

                if (io) {
                    io.emit('round_reset', {
                        roundId: currentRound.roundId,
                        timeLeft: currentRound.timeLeft,
                        status: currentRound.status
                    });
                }
            }
        }
    }, 1000);

    // የአሁንን የዙር ሁኔታ ማሳያ
    router.get('/status', (req, res) => {
        res.json({
            success: true,
            roundId: currentRound.roundId,
            timeLeft: currentRound.timeLeft,
            status: currentRound.status,
            winningDraw: currentRound.winningDraw
        });
    });

    // የውርርድ መቀበያ ሩት
    router.post('/play', async (req, res) => {
        const { picks, stake, identifier } = req.body;

        if (currentRound.status !== 'BETTING') {
            return res.status(400).json({ success: false, error: 'ውርርድ ተዘግቷል! እባክዎ ቀጣዩን ዙር ይጠብቁ።' });
        }

        if (!identifier || !Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
            return res.status(400).json({ success: false, error: 'እባክዎ ከ 1 እስከ 10 ቁጥሮች ይምረጡ።' });
        }

        const numericStake = parseFloat(stake);
        if (isNaN(numericStake) || numericStake < 10) {
            return res.status(400).json({ success: false, error: 'አነስተኛ የውርርድ መጠን 10 ብር ነው።' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const userRes = await client.query('SELECT * FROM users WHERE identifier = $1 FOR UPDATE', [identifier]);
            if (userRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'ተጠቃሚው አልተገኘም!' });
            }

            let user = userRes.rows[0];
            let currentBalance = parseFloat(user.balance);

            if (currentBalance < numericStake) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'በቂ ባላንስ የለዎትም!' });
            }

            let newBalance = currentBalance - numericStake;
            await client.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, identifier]);

            // ቲኬቱን ማስቀመጥ
            await client.query(
                `INSERT INTO keno_bets (user_identifier, round_id, picks, stake, status) 
                 VALUES ($1, $2, $3, $4, 'WAITING')`,
                [identifier, currentRound.roundId, JSON.stringify(picks), numericStake]
            );

            await client.query('COMMIT');

            res.json({
                success: true,
                round: currentRound.roundId,
                balance: newBalance,
                message: 'ውርርዱ ተመዝግቧል!'
            });

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Keno error:', err.message);
            res.status(500).json({ success: false, error: 'ሰርቨር ላይ ስህተት ተፈጥሯል።' });
        } finally {
            client.release();
        }
    });

    // አሸናፊዎችን በሰርቨር በኩል በራስ ሰር የማስላት እና የመክፈል ተግባር
    async function processRoundPayouts(roundId, draw) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const betsRes = await client.query('SELECT * FROM keno_bets WHERE round_id = $1 AND status = $2', [roundId, 'WAITING']);
            const winningSet = new Set(draw);

            for (let bet of betsRes.rows) {
                let picks = bet.picks;
                let stake = parseFloat(bet.stake);
                let matchedCount = picks.filter(n => winningSet.has(n)).length;

                let multiplier = 0;
                let pickSize = picks.length;
                if (PAYTABLE[pickSize] && PAYTABLE[pickSize][matchedCount]) {
                    multiplier = PAYTABLE[pickSize][matchedCount];
                }
                let payout = stake * multiplier;
                let status = payout > 0 ? 'WON' : 'LOST';

                // ቲኬቱን ማዘመን
                await client.query(
                    'UPDATE keno_bets SET matched = $1, payout = $2, status = $3 WHERE id = $4',
                    [matchedCount, payout, status, bet.id]
                );

                // አሸናፊ ከሆነ ባላንሱ ላይ መጨመር
                if (payout > 0) {
                    await client.query(
                        'UPDATE users SET balance = balance + $1 WHERE identifier = $2',
                        [payout, bet.user_identifier]
                    );
                }
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Payout processing error:', err.message);
        } finally {
            client.release();
        }
    }

    return router;
};
