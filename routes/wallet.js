const express = require('express');

module.exports = function(pool) {
    const router = express.Router();

    // 1. ተጠቃሚውን ከቴሌግራም ሲመዘገብ/ሲገባ ማስተካከል (Sync User & Wallet)
    router.post('/sync', async (req, res) => {
        const { telegram_id, name, username, phone } = req.body;

        if (!telegram_id) {
            return res.status(400).json({ success: false, error: 'Telegram ID is required' });
        }

        try {
            // ተጠቃሚው ዳታቤዝ ውስጥ መኖሩን ማረጋገጥ
            let userCheck = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);

            if (userCheck.rows.length === 0) {
                // የሲግነፕ ቦነስ (Signup Bonus) ከ settings ቴብል ማምጣት
                const bonusRes = await pool.query("SELECT value FROM settings WHERE key = 'signup_bonus'");
                const bonusAmount = bonusRes.rows.length > 0 ? parseFloat(bonusRes.rows.value) : 0.00;

                // አዲስ ተጠቃሚ መመዝገብ
                const newUser = await pool.query(
                    `INSERT INTO users (telegram_id, name, username, phone, balance, bonus_balance) 
                     VALUES ($1, $2, $3, $4, 0.00, $5) RETURNING *`,
                    [telegram_id, name, username, phone || null, bonusAmount]
                );
                return res.status(201).json({ success: true, user: newUser.rows[0] });
            }

            res.json({ success: true, user: userCheck.rows[0] });
        } catch (err) {
            console.error('Error syncing user:', err.message);
            res.status(500).json({ success: false, error: 'Server Error during user sync' });
        }
    });

    // 2. የኪስ ቦርሳ ባላንስ ማየት
    router.get('/balance/:telegram_id', async (req, res) => {
        const { telegram_id } = req.params;

        try {
            const user = await pool.query(
                'SELECT balance, bonus_balance FROM users WHERE telegram_id = $1', 
                [telegram_id]
            );

            if (user.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            res.json({ 
                success: true, 
                balance: user.rows[0].balance, 
                bonus_balance: user.rows[0].bonus_balance 
            });
        } catch (err) {
            console.error('Error fetching balance:', err.message);
            res.status(500).json({ success: false, error: 'Server Error' });
        }
    });

    return router;
};
