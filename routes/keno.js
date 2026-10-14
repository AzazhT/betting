const express = require('express');

module.exports = function(pool) {
    const router = express.Router();

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

            let newBalance = currentBalance - stake;
            await client.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, identifier]);

            let draw = [];
            while (draw.length < 20) {
                let r = Math.floor(Math.random() * 80) + 1;
                if (!draw.includes(r)) draw.push(r);
            }

            const winningSet = new Set(draw);
            const matchedCount = picks.filter(n => winningSet.has(n)).length;

            let multiplier = 0;
            const pickSize = picks.length;
            if (PAYTABLE[pickSize] && PAYTABLE[pickSize][matchedCount]) {
                multiplier = PAYTABLE[pickSize][matchedCount];
            }
            let payout = stake * multiplier;

            if (payout > 0) {
                newBalance += payout;
                await client.query('UPDATE users SET balance = $1 WHERE identifier = $2', [newBalance, identifier]);
            }

            await client.query('COMMIT');

            res.json({
                success: true,
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
