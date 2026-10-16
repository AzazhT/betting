const express = require('express');

module.exports = function (pool) {
  const router = express.Router();

  const MIN_AMOUNT = 50;
  const MAX_AMOUNT = 100000;

  // Deposit/Withdraw requests table
  let tableReady;

  function ensureRequestsTable() {
    if (!tableReady) {
      tableReady = pool.query(`
        CREATE TABLE IF NOT EXISTS wallet_requests (
          id BIGSERIAL PRIMARY KEY,
          telegram_id VARCHAR(100) NOT NULL,
          request_type VARCHAR(10) NOT NULL
            CHECK (request_type IN ('deposit', 'withdraw')),
          amount NUMERIC(12,2) NOT NULL CHECK (amount >= 50),
          payment_method VARCHAR(30) NOT NULL,
          reference TEXT,
          account_details TEXT,
          status VARCHAR(20) NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'approved', 'rejected')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at TIMESTAMPTZ,
          admin_note TEXT
        )
      `).catch(err => {
        tableReady = null;
        throw err;
      });
    }

    return tableReady;
  }

  function validAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) &&
      amount >= MIN_AMOUNT &&
      amount <= MAX_AMOUNT &&
      Math.round(amount * 100) === amount * 100;
  }

  // Sync Telegram user and wallet
  router.post('/sync', async (req, res) => {
    const { telegram_id, name, username, phone } = req.body;

    if (!telegram_id) {
      return res.status(400).json({
        success: false,
        error: 'Telegram ID is required'
      });
    }

    try {
      const userCheck = await pool.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [String(telegram_id)]
      );

      if (userCheck.rows.length === 0) {
        const bonusRes = await pool.query(
          "SELECT value FROM settings WHERE key = 'signup_bonus'"
        );

        const parsedBonus = Number(bonusRes.rows[0]?.value ?? 0);
        const bonusAmount =
          Number.isFinite(parsedBonus) && parsedBonus >= 0
            ? parsedBonus
            : 0;

        const newUser = await pool.query(
          `INSERT INTO users
            (telegram_id, name, username, phone, balance, bonus_balance)
           VALUES ($1, $2, $3, $4, 0.00, $5)
           RETURNING *`,
          [
            String(telegram_id),
            name || '',
            username || '',
            phone || null,
            bonusAmount
          ]
        );

        return res.status(201).json({
          success: true,
          user: newUser.rows[0]
        });
      }

      return res.json({
        success: true,
        user: userCheck.rows[0]
      });
    } catch (err) {
      console.error('Wallet sync error:', err.message);
      return res.status(500).json({
        success: false,
        error: 'Server error during user sync'
      });
    }
  });

  // Get wallet balance
  router.get('/balance/:telegram_id', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT balance, bonus_balance
         FROM users WHERE telegram_id = $1`,
        [String(req.params.telegram_id)]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      res.json({
        success: true,
        balance: result.rows[0].balance,
        bonus_balance: result.rows[0].bonus_balance
      });
    } catch (err) {
      console.error('Balance error:', err.message);
      res.status(500).json({
        success: false,
        error: 'Could not fetch balance'
      });
    }
  });

  // Submit a deposit or withdrawal request
  router.post('/request', async (req, res) => {
    const {
      telegram_id,
      request_type,
      amount,
      payment_method,
      reference,
      account_details
    } = req.body;

    if (!telegram_id) {
      return res.status(400).json({
        success: false,
        error: 'Telegram ID is required'
      });
    }

    if (!['deposit', 'withdraw'].includes(request_type)) {
      return res.status(400).json({
        success: false,
        error: 'Request type must be deposit or withdraw'
      });
    }

    if (!validAmount(amount)) {
      return res.status(400).json({
        success: false,
        error: 'Minimum amount is 50 ETB; maximum is 100,000 ETB'
      });
    }

    if (!['Telebirr', 'Bank'].includes(payment_method)) {
      return res.status(400).json({
        success: false,
        error: 'Choose a valid payment method'
      });
    }

    if (
      request_type === 'deposit' &&
      (!reference || !String(reference).trim())
    ) {
      return res.status(400).json({
        success: false,
        error: 'Payment reference is required'
      });
    }

    if (
      request_type === 'withdraw' &&
      (!account_details || !String(account_details).trim())
    ) {
      return res.status(400).json({
        success: false,
        error: 'Withdrawal account details are required'
      });
    }

    const client = await pool.connect();

    try {
      await ensureRequestsTable();
      await client.query('BEGIN');

      const userResult = await client.query(
        `SELECT telegram_id, balance
         FROM users
         WHERE telegram_id = $1
         FOR UPDATE`,
        [String(telegram_id)]
      );

      if (!userResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'User not found. Open the app again first.'
        });
      }

      // Check funds reserved by other pending withdrawal requests.
      if (request_type === 'withdraw') {
        const pendingResult = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS pending_total
           FROM wallet_requests
           WHERE telegram_id = $1
             AND request_type = 'withdraw'
             AND status = 'pending'`,
          [String(telegram_id)]
        );

        const balance = Number(userResult.rows[0].balance);
        const pending = Number(pendingResult.rows[0].pending_total);
        const available = balance - pending;

        if (Number(amount) > available) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            error: 'Insufficient available balance',
            available_balance: Math.max(0, available)
          });
        }
      }

      const result = await client.query(
        `INSERT INTO wallet_requests
          (telegram_id, request_type, amount, payment_method,
           reference, account_details)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, request_type, amount, payment_method,
                   status, created_at`,
        [
          String(telegram_id),
          request_type,
          Number(amount),
          payment_method,
          request_type === 'deposit'
            ? String(reference || '').trim()
            : null,
          request_type === 'withdraw'
            ? String(account_details || '').trim()
            : null
        ]
      );

      await client.query('COMMIT');

      return res.status(201).json({
        success: true,
        message: 'Request submitted. It is pending review.',
        request: result.rows[0]
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Wallet request error:', err.message);

      return res.status(500).json({
        success: false,
        error: 'Could not submit wallet request'
      });
    } finally {
      client.release();
    }
  });

  // View a user's wallet request history
  router.get('/requests/:telegram_id', async (req, res) => {
    try {
      await ensureRequestsTable();

      const result = await pool.query(
        `SELECT id, request_type, amount, payment_method,
                status, created_at, reviewed_at, admin_note
         FROM wallet_requests
         WHERE telegram_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [String(req.params.telegram_id)]
      );

      res.json({
        success: true,
        requests: result.rows
      });
    } catch (err) {
      console.error('Wallet request history error:', err.message);
      res.status(500).json({
        success: false,
        error: 'Could not fetch request history'
      });
    }
  });

  // Admin authentication: keep this token secret on the server.
  function requireAdmin(req, res, next) {
    const configuredToken = process.env.ADMIN_API_TOKEN;
    const authHeader = req.headers.authorization || '';
    const suppliedToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';

    if (!configuredToken || !suppliedToken ||
        suppliedToken !== configuredToken) {
      return res.status(403).json({
        success: false,
        error: 'Admin access denied'
      });
    }

    next();
  }

  // List pending deposit and withdrawal requests for the admin.
  router.get('/admin/requests', requireAdmin, async (req, res) => {
    try {
      await ensureRequestsTable();

      const result = await pool.query(`
        SELECT id, telegram_id, request_type, amount,
               payment_method, reference, account_details,
               status, created_at
        FROM wallet_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 200
      `);

      return res.json({
        success: true,
        requests: result.rows
      });
    } catch (err) {
      console.error('Admin request list error:', err.message);
      return res.status(500).json({
        success: false,
        error: 'Could not load pending requests'
      });
    }
  });

  // Approve or reject one request.
  router.post('/admin/requests/:id/review', requireAdmin, async (req, res) => {
    const requestId = req.params.id;
    const { action, admin_note } = req.body || {};

    if (!/^\d+$/.test(requestId) ||
        !['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request ID or action'
      });
    }

    const client = await pool.connect();

    try {
      await ensureRequestsTable();
      await client.query('BEGIN');

      const requestResult = await client.query(
        `SELECT *
         FROM wallet_requests
         WHERE id = $1
         FOR UPDATE`,
        [requestId]
      );

      if (!requestResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Request not found'
        });
      }

      const request = requestResult.rows[0];

      if (request.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'This request has already been reviewed'
        });
      }

      const userResult = await client.query(
        `SELECT telegram_id, balance
         FROM users
         WHERE telegram_id = $1
         FOR UPDATE`,
        [request.telegram_id]
      );

      if (!userResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Wallet user not found'
        });
      }

      const amount = Number(request.amount);
      const balance = Number(userResult.rows[0].balance);

      if (action === 'approve') {
        if (request.request_type === 'deposit') {
          await client.query(
            `UPDATE users
             SET balance = balance + $1
             WHERE telegram_id = $2`,
            [amount, request.telegram_id]
          );
        } else {
          // Recheck funds while the user's wallet row is locked.
          const pendingResult = await client.query(
            `SELECT COALESCE(SUM(amount), 0) AS pending_total
             FROM wallet_requests
             WHERE telegram_id = $1
               AND request_type = 'withdraw'
               AND status = 'pending'
               AND id <> $2`,
            [request.telegram_id, request.id]
          );

          const otherPending = Number(
            pendingResult.rows[0].pending_total
          );

          if (amount > balance - otherPending) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              success: false,
              error: 'Insufficient available balance to approve withdrawal'
            });
          }

          await client.query(
            `UPDATE users
             SET balance = balance - $1
             WHERE telegram_id = $2`,
            [amount, request.telegram_id]
          );
        }
      }

      const newStatus = action === 'approve' ? 'approved' : 'rejected';

      await client.query(
        `UPDATE wallet_requests
         SET status = $1,
             reviewed_at = NOW(),
             admin_note = $2
         WHERE id = $3`,
        [
          newStatus,
          typeof admin_note === 'string'
            ? admin_note.slice(0, 500)
            : null,
          request.id
        ]
      );

      await client.query('COMMIT');

      return res.json({
        success: true,
        message: action === 'approve'
          ? 'Request approved and wallet updated'
          : 'Request rejected',
        request_id: request.id,
        status: newStatus
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Admin review error:', err.message);

      return res.status(500).json({
        success: false,
        error: 'Could not review wallet request'
      });
    } finally {
      client.release();
    }
  });

  return router;
};
