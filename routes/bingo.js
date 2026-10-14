const express = require('express');

module.exports = function(pool, io) {
    const router = express.Router();

    // 1. የቢንጎ ውርርድ ማስቀመጫ እና ካርድ ማግኛ API
    router.post('/join', async (req, res) => {
        const { telegram_id, stake_amount } = req.body;

        if (!telegram_id || !stake_amount) {
            return res.status(400).json({ success: false, error: 'Telegram ID and stake amount are required' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN'); // ዱቤ እና ገንዘብ ዝውውር ጥንቃቄ (Transaction)

            // ተጠቃሚውን መፈለግ
            const userRes = await client.query('SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE', [telegram_id]);
            if (userRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            const user = userRes.rows[0];
            const currentBalance = parseFloat(user.balance);

            if (currentBalance < parseFloat(stake_amount)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: 'Insufficient balance' });
            }

            // ከባላንስ ላይ ውርርዱን መቀነስ
            const newBalance = currentBalance - parseFloat(stake_amount);
            await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, user.id]);

            // በ bets ቴብል ላይ መዝገብ መፍጠር
            const betRes = await client.query(
                `INSERT INTO bets (user_id, game, stake, potential_win, status) 
                 VALUES ($1, 'bingo', $2, $3, 'pending') RETURNING *`,
                [user.id, stake_amount, parseFloat(stake_amount) * 2] // ምሳሌ፡ ድርብ ሽልማት
            );

            await client.query('COMMIT');

            res.json({
                success: true,
                message: "ወደ ቢንጎ ጨዋታ ተቀላቅለዋል!",
                balance: newBalance,
                bet: betRes.rows[0]
            });

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Error in bingo join:', err.message);
            res.status(500).json({ success: false, error: 'Server error during bingo join' });
        } finally {
            client.release();
        }
    });

    return router;
};
