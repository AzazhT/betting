const express = require('express');

module.exports = function(pool, io) {
    const router = express.Router();

    // የኬኖ Paytable (ማባዣዎች)
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

    // የአሁንን የዙር መረጃ ማከማቻ
    let currentRound = {
        roundId: Date.now(),
        timeLeft: 60, // በየ 60 ሰከንዱ
        status: 'BETTING' // BETTING, DRAWING, CLOSED
    };

    // በየ 1 ሰከንዱ የሚቆጠር ሰአት ቆጣሪ (Timer)
    setInterval(() => {
        currentRound.timeLeft--;
        if (currentRound.timeLeft <= 0) {
            // 60 ሰከንድ ሲያልቅ ዙሩ ተዘግቶ አዲስ ዙር ይጀመራል
            currentRound.roundId = Date.now();
            currentRound.timeLeft = 60;
        }
        // የተጠቃሚዎችን ሰአት በ Socket.io ማሳወቅ ከፈለጉ እዚህ ጋር መላክ ይቻላል
    }, 1000);

    // የዙር ሰአት ሁኔታን ማሳያ ሩት
    router.get('/status', (req, res) => {
        res.json({
            success: true,
            roundId: currentRound.roundId,
            timeLeft: currentRound.timeLeft,
            status: currentRound.status
        });
    });

    // የኬኖ ጨዋታ ውርርድ መቀበያ ሩት
    router.post('/play', async (req, res) => {
        const { picks, stake, identifier } = req.body;

        if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
            return res.status(400).json({ success: false, error: 'እባክዎ ከ 1 እስከ 10 ቁጥሮች ይምረጡ።' });
        }

        if (!stake || stake <= 0) {
            return res.status(400).json({ success: false, error: 'ትክክለኛ የውርርድ መጠን ይምረጡ።' });
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

            if (currentBalance < stake) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'በቂ ባላንስ የለዎትም!' });
            }

            // ባላንሱን መቀነስ (Stake)
            let newBalance = currentBalance - stake;
            await client.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, identifier]);

            // 20 የዘፈቀደ የኬኖ ቁጥሮችን ከ 1 እስከ 80 ማውጣት
            let draw = [];
            while (draw.length < 20) {
                let r = Math.floor(Math.random() * 80) + 1;
                if (!draw.includes(r)) draw.push(r);
            }

            // ትክክለኛ የገጣሚ ቁጥሮች (Matches) ብዛት ማወቅ
            const winningSet = new Set(draw);
            const matchedCount = picks.filter(n => winningSet.has(n)).length;

            // Payout ማስላት
            let multiplier = 0;
            const pickSize = picks.length;
            if (PAYTABLE[pickSize] && PAYTABLE[pickSize][matchedCount]) {
                multiplier = PAYTABLE[pickSize][matchedCount];
            }
            let payout = stake * multiplier;

            // አሸናፊ ከሆነ ባላንሱ ላይ መጨመር
            if (payout > 0) {
                newBalance += payout;
                await client.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, identifier]);
            }

            await client.query('COMMIT');

            res.json({
                success: true,
                round: currentRound.roundId,
                draw: draw,
                matched: matchedCount,
                payout: payout,
                balance: newBalance
            });

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Keno error:', err.message);
            res.status(500).json({ success: false, error: 'ሰርቨር ላይ ስህተት ተፈጥሯል።' });
        } finally {
            client.release();
        }
    });

    return router;
};
