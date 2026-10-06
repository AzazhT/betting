const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_URL = "https://v3.football.api-sports.io";
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 10000;

/*
|--------------------------------------------------------------------------
| PostgreSQL
|--------------------------------------------------------------------------
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err.message);
});

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/*
|--------------------------------------------------------------------------
| Database Initialization
|--------------------------------------------------------------------------
*/

async function initializeDatabase() {
  try {
    const schemaPath = path.join(__dirname, "schema.sql");

    if (!fs.existsSync(schemaPath)) {
      console.log("⚠️ schema.sql not found.");
      return;
    }

    const schema = fs.readFileSync(schemaPath, "utf8");

    await pool.query(schema);

    console.log("✅ Database tables initialized successfully.");

  } catch (error) {
    console.error(
      "❌ Database initialization failed:",
      error.message
    );

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| Home
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Ethiopia Betting",
    status: "online"
  });
});

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS time"
    );

    res.json({
      success: true,
      server: "healthy",
      database: "healthy",
      time: result.rows[0].time
    });

  } catch (error) {
    console.error(
      "Health check error:",
      error.message
    );

    res.status(500).json({
      success: false,
      server: "healthy",
      database: "error"
    });
  }
});

/*
|--------------------------------------------------------------------------
| Database Test
|--------------------------------------------------------------------------
*/

app.get("/api/database-test", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS user
    `);

    res.json({
      success: true,
      message: "PostgreSQL connection successful.",
      database: result.rows[0].database,
      user: result.rows[0].user
    });

  } catch (error) {
    console.error(
      "Database connection error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Database connection failed."
    });
  }
});

/*
|--------------------------------------------------------------------------
| Tables Test
|--------------------------------------------------------------------------
*/

app.get("/api/tables-test", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    res.json({
      success: true,
      tables: result.rows.map(
        row => row.table_name
      )
    });

  } catch (error) {
    console.error(
      "Tables test error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Could not read database tables."
    });
  }
});

/*
|--------------------------------------------------------------------------
| User Account
|--------------------------------------------------------------------------
*/

app.post("/api/user", async (req, res) => {
  try {

    const {
      telegram_id,
      name,
      username,
      phone
    } = req.body;

    if (!telegram_id) {
      return res.status(400).json({
        success: false,
        message: "telegram_id is required."
      });
    }

    /*
    | Check existing user
    */

    const existingUser = await pool.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [telegram_id]
    );

    if (existingUser.rows.length > 0) {

      return res.json({
        success: true,
        new_user: false,
        user: existingUser.rows[0]
      });
    }

    /*
    | New user
    */

    const signupBonus = 50.00;

    const result = await pool.query(
      `
      INSERT INTO users
        (
          telegram_id,
          name,
          username,
          phone,
          balance,
          bonus_balance
        )
      VALUES
        ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        telegram_id,
        name || "Player",
        username || "",
        phone || "",
        signupBonus,
        signupBonus
      ]
    );

    const user = result.rows[0];

    /*
    | Record signup bonus
    */

    await pool.query(
      `
      INSERT INTO transactions
        (
          user_id,
          type,
          amount,
          status,
          reference,
          description
        )
      VALUES
        ($1, $2, $3, $4, $5, $6)
      `,
      [
        user.id,
        "signup_bonus",
        signupBonus,
        "completed",
        `SIGNUP-${user.id}`,
        "50 ETB signup bonus"
      ]
    );

    res.json({
      success: true,
      new_user: true,
      message: "Account created successfully.",
      user
    });

  } catch (error) {

    console.error(
      "User account error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Could not create user account."
    });
  }
});

/*
|--------------------------------------------------------------------------
| User Test
|--------------------------------------------------------------------------
*/

app.get("/api/user-test", async (req, res) => {
  try {

    const telegramId = "TEST_USER_001";

    /*
    | Check test user
    */

    let result = await pool.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [telegramId]
    );

    /*
    | Create test user if not found
    */

    if (result.rows.length === 0) {

      const signupBonus = 50.00;

      result = await pool.query(
        `
        INSERT INTO users
          (
            telegram_id,
            name,
            username,
            balance,
            bonus_balance
          )
        VALUES
          ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [
          telegramId,
          "Test Player",
          "test_player",
          signupBonus,
          signupBonus
        ]
      );

      const user = result.rows[0];

      /*
      | Record test bonus
      */

      await pool.query(
        `
        INSERT INTO transactions
          (
            user_id,
            type,
            amount,
            status,
            reference,
            description
          )
        VALUES
          ($1, $2, $3, $4, $5, $6)
        `,
        [
          user.id,
          "signup_bonus",
          signupBonus,
          "completed",
          `TEST-SIGNUP-${user.id}`,
          "Test 50 ETB signup bonus"
        ]
      );

      return res.json({
        success: true,
        new_user: true,
        user
      });
    }

    /*
    | Existing test user
    */

    res.json({
      success: true,
      new_user: false,
      user: result.rows[0]
    });

  } catch (error) {

    console.error(
      "User test error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "User test failed."
    });
  }
});

/*
|--------------------------------------------------------------------------
| Betting - Place Bet
|--------------------------------------------------------------------------
*/
// ===============================
// MATCH API
// ===============================

// Get all matches
app.get("/api/football/test", async (req, res) => {
  app.get("/api/football/odds-test", async (req, res) => {
  try {
    const response = await fetch(
      `${API_FOOTBALL_URL}/odds?date=2026-10-06`,
      {
        headers: {
          "x-apisports-key": API_FOOTBALL_KEY
        }
      }
    );

    const data = await response.json();

    res.json({
      success: true,
      results: data.results,
      response: data.response
    });
  } catch (error) {
    console.error("API-Football odds error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load football odds."
    });
  }
});
  try {
    const response = await fetch(
      `${API_FOOTBALL_URL}/fixtures?date=2026-10-06`,
      {
        headers: {
          "x-apisports-key": API_FOOTBALL_KEY
        }
      }
    );

    const data = await response.json();

    res.json({
      success: true,
      results: data.results,
      response: data.response
    });
  } catch (error) {
    console.error("API-Football error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to connect to API-Football."
    });
  }
});
app.get("/api/matches", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        external_id,
        home_team,
        away_team,
        status,
        home_score,
        away_score,
        result,
        started_at,
        finished_at
      FROM matches
      ORDER BY started_at ASC NULLS LAST, id ASC
    `);

    res.json({
      success: true,
      matches: result.rows
    });
  } catch (error) {
    console.error("Get matches error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load matches."
    });
  }
});


// Get one match
app.get("/api/matches/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        id,
        external_id,
        home_team,
        away_team,
        status,
        home_score,
        away_score,
        result,
        started_at,
        finished_at
      FROM matches
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Match not found."
      });
    }

    res.json({
      success: true,
      match: result.rows[0]
    });
  } catch (error) {
    console.error("Get match error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load match."
    });
  }
});

app.post("/api/bets/place", async (req, res) => {

  const client = await pool.connect();

  try {

    const {
      telegram_id,
      game,
      selections,
      stake
    } = req.body;

    if (!telegram_id) {

      return res.status(400).json({
        success: false,
        message: "telegram_id is required."
      });
    }

    if (!game) {

      return res.status(400).json({
        success: false,
        message: "game is required."
      });
    }

    if (
      !Array.isArray(selections) ||
      selections.length === 0
    ) {

      return res.status(400).json({
        success: false,
        message: "At least one selection is required."
      });
    }

    const amount = Number(stake);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      return res.status(400).json({
        success: false,
        message: "Invalid stake amount."
      });
    }

    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT *
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [telegram_id]
    );

    if (userResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {

      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        message: "User account is inactive."
      });
    }

    const balance = Number(user.balance);

    if (balance < amount) {

      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Insufficient balance."
      });
    }

    let totalOdds = 1;

    for (const selection of selections) {

      const odd = Number(selection.odd);

      if (
        !Number.isFinite(odd) ||
        odd <= 1
      ) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "Invalid odds."
        });
      }

      totalOdds *= odd;
    }

    totalOdds =
      Number(totalOdds.toFixed(4));

    const potentialWin =
      Number(
        (amount * totalOdds).toFixed(2)
      );

    const betResult = await client.query(
      `
      INSERT INTO bets
        (
          user_id,
          game,
          stake,
          potential_win,
          actual_win,
          status,
          result
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        user.id,
        game,
        amount,
        potentialWin,
        0,
        "pending",
        JSON.stringify({
          selections,
          total_odds: totalOdds
        })
      ]
    );

    const newBalance =
      Number(
        (balance - amount).toFixed(2)
      );

    await client.query(
      `
      UPDATE users
      SET
        balance = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        newBalance,
        user.id
      ]
    );

    await client.query(
      `
      INSERT INTO transactions
        (
          user_id,
          type,
          amount,
          status,
          reference,
          description
        )
      VALUES
        ($1, $2, $3, $4, $5, $6)
      `,
      [
        user.id,
        "bet",
        amount,
        "completed",
        `BET-${betResult.rows[0].id}`,
        `${game} betting stake`
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Bet placed successfully.",
      bet: betResult.rows[0],
      balance: newBalance
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "Place bet error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Could not place bet."
    });

  } finally {

    client.release();

  }
});

/*
|--------------------------------------------------------------------------
| TEST ONLY - Automatic Bet Settlement
|--------------------------------------------------------------------------
|
| This endpoint is for testing only.
|
| It randomly settles ONE pending bet as:
|
| Won  -> potential_win is credited
| Lost -> nothing is credited
|
| It uses crypto.randomInt so the result is not
| based on the player, stake, or balance.
|
| Remove/restrict this endpoint before production.
|
|--------------------------------------------------------------------------
*/

app.post("/api/test/settle-bet", async (req, res) => {

  const client = await pool.connect();

  try {

    const requestedBetId =
      req.body && req.body.bet_id
        ? Number(req.body.bet_id)
        : null;

    await client.query("BEGIN");

    /*
    | Find pending bet
    */

    let betResult;

    if (
      requestedBetId &&
      Number.isInteger(requestedBetId) &&
      requestedBetId > 0
    ) {

      betResult = await client.query(
        `
        SELECT
          b.*,
          u.telegram_id,
          u.balance
        FROM bets b
        INNER JOIN users u
          ON u.id = b.user_id
        WHERE b.id = $1
          AND b.status = 'pending'
        FOR UPDATE OF b
        `,
        [requestedBetId]
      );

    } else {

      betResult = await client.query(
        `
        SELECT
          b.*,
          u.telegram_id,
          u.balance
        FROM bets b
        INNER JOIN users u
          ON u.id = b.user_id
        WHERE b.status = 'pending'
        ORDER BY b.id ASC
        LIMIT 1
        FOR UPDATE OF b
        `
      );
    }

    if (betResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "No pending bet found."
      });
    }

    const bet = betResult.rows[0];

    /*
    | Lock user row too
    */

    const userResult = await client.query(
      `
      SELECT *
      FROM users
      WHERE id = $1
      FOR UPDATE
      `,
      [bet.user_id]
    );

    if (userResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Bet user not found."
      });
    }

    const user = userResult.rows[0];

    /*
    | Fair random test result
    |
    | 0 = Lost
    | 1 = Won
    */

    const randomResult =
      crypto.randomInt(0, 2);

    const won =
      randomResult === 1;

    const status =
      won
        ? "won"
        : "lost";

    const actualWin =
      won
        ? Number(bet.potential_win)
        : 0;

    const currentBalance =
      Number(user.balance);

    const newBalance =
      won
        ? Number(
            (currentBalance + actualWin).toFixed(2)
          )
        : currentBalance;

    /*
    | Save result
    */

    const resultData = {
      test_mode: true,
      outcome: status,
      settled_by: "automatic_test_settlement",
      settled_at: new Date().toISOString()
    };

    await client.query(
      `
      UPDATE bets
      SET
        actual_win = $1,
        status = $2,
        result = COALESCE(result, '{}'::jsonb) || $3::jsonb,
        settled_at = NOW()
      WHERE id = $4
        AND status = 'pending'
      `,
      [
        actualWin,
        status,
        JSON.stringify(resultData),
        bet.id
      ]
    );

    /*
    | Credit winnings only if Won
    */

    if (won) {

      await client.query(
        `
        UPDATE users
        SET
          balance = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          newBalance,
          user.id
        ]
      );

      /*
      | Record winning transaction
      */

      await client.query(
        `
        INSERT INTO transactions
          (
            user_id,
            type,
            amount,
            status,
            reference,
            description
          )
        VALUES
          ($1, $2, $3, $4, $5, $6)
        `,
        [
          user.id,
          "bet_win",
          actualWin,
          "completed",
          `WIN-${bet.id}`,
          `Bet #${bet.id} winning payout`
        ]
      );

    } else {

      /*
      | Record losing settlement
      */

      await client.query(
        `
        INSERT INTO transactions
          (
            user_id,
            type,
            amount,
            status,
            reference,
            description
          )
        VALUES
          ($1, $2, $3, $4, $5, $6)
        `,
        [
          user.id,
          "bet_loss",
          0,
          "completed",
          `LOSS-${bet.id}`,
          `Bet #${bet.id} lost`
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message:
        won
          ? "Bet settled as WON."
          : "Bet settled as LOST.",
      bet_id: bet.id,
      telegram_id: bet.telegram_id,
      status,
      stake: Number(bet.stake),
      potential_win: Number(bet.potential_win),
      actual_win: actualWin,
      balance: newBalance
    });

  } catch (error) {

    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Settlement rollback error:",
        rollbackError.message
      );
    }

    console.error(
      "Automatic settlement error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message:
        "Could not settle bet."
    });

  } finally {

    client.release();

  }
});

/*
|--------------------------------------------------------------------------
| Bet History
|--------------------------------------------------------------------------
*/

app.get("/api/bets/history", async (req, res) => {

  try {

    const {
      telegram_id
    } = req.query;

    if (!telegram_id) {

      return res.status(400).json({
        success: false,
        message: "telegram_id is required."
      });
    }

    const result = await pool.query(
      `
      SELECT
        b.id,
        b.game,
        b.stake,
        b.potential_win,
        b.actual_win,
        b.status,
        b.result,
        b.created_at,
        b.settled_at
      FROM bets b
      INNER JOIN users u
        ON u.id = b.user_id
      WHERE u.telegram_id = $1
      ORDER BY b.created_at DESC
      LIMIT 50
      `,
      [telegram_id]
    );

    res.json({
      success: true,
      bets: result.rows
    });

  } catch (error) {

    console.error(
      "Bet history error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Could not load bet history."
    });
  }
});

/*
|--------------------------------------------------------------------------
| Deposit Request
|--------------------------------------------------------------------------
*/

app.post("/api/deposit/request", async (req, res) => {

  const client = await pool.connect();

  try {

    const {
      telegram_id,
      amount,
      method,
      reference
    } = req.body;

    if (!telegram_id) {

      return res.status(400).json({
        success: false,
        message: "telegram_id is required."
      });
    }

    const depositAmount = Number(amount);

    if (
      !Number.isFinite(depositAmount) ||
      depositAmount <= 0
    ) {

      return res.status(400).json({
        success: false,
        message: "Invalid deposit amount."
      });
    }

    if (!method) {

      return res.status(400).json({
        success: false,
        message: "Payment method is required."
      });
    }

    const minimumDepositResult =
      await pool.query(
        `
        SELECT value
        FROM settings
        WHERE key = 'minimum_deposit'
        `
      );

    const minimumDeposit =
      minimumDepositResult.rows.length > 0
        ? Number(
            minimumDepositResult.rows[0].value
          )
        : 51;

    if (depositAmount < minimumDeposit) {

      return res.status(400).json({
        success: false,
        message:
          `Minimum deposit is ${minimumDeposit} ETB.`
      });
    }

    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT *
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [telegram_id]
    );

    if (userResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {

      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        message: "User account is inactive."
      });
    }

    const cleanReference =
      reference &&
      String(reference).trim()
        ? String(reference).trim()
        : null;

    const platformReference =
      `DEP-${user.id}-${Date.now()}-${Math.floor(
        Math.random() * 100000
      )}`;

    const description =
      cleanReference
        ? `${method} deposit request | Payment reference: ${cleanReference}`
        : `${method} deposit request`;

    const transactionResult =
      await client.query(
        `
        INSERT INTO transactions
          (
            user_id,
            type,
            amount,
            status,
            reference,
            description
          )
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [
          user.id,
          "deposit",
          depositAmount,
          "pending",
          platformReference,
          description
        ]
      );

    await client.query("COMMIT");

    res.json({
      success: true,
      message:
        "Deposit request submitted successfully.",
      transaction:
        transactionResult.rows[0]
    });

  } catch (error) {

    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Deposit rollback error:",
        rollbackError.message
      );
    }

    console.error(
      "Deposit request error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message:
        "Could not create deposit request."
    });

  } finally {

    client.release();

  }
});

/*
|--------------------------------------------------------------------------
| Withdraw Request
|--------------------------------------------------------------------------
*/

app.post("/api/withdraw/request", async (req, res) => {

  const client = await pool.connect();

  try {

    const {
      telegram_id,
      amount,
      method,
      account
    } = req.body;

    /*
    | Validate Telegram ID
    */

    if (!telegram_id) {

      return res.status(400).json({
        success: false,
        message: "telegram_id is required."
      });
    }

    /*
    | Validate amount
    */

    const withdrawAmount = Number(amount);

    if (
      !Number.isFinite(withdrawAmount) ||
      withdrawAmount <= 0
    ) {

      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal amount."
      });
    }

    /*
    | Validate method
    */

    if (!method) {

      return res.status(400).json({
        success: false,
        message: "Withdrawal method is required."
      });
    }

    /*
    | Validate account
    */

    if (
      !account ||
      !String(account).trim()
    ) {

      return res.status(400).json({
        success: false,
        message: "Withdrawal account is required."
      });
    }

    /*
    | Get minimum withdrawal
    */

    const minimumWithdrawResult =
      await pool.query(
        `
        SELECT value
        FROM settings
        WHERE key = 'minimum_withdraw'
        `
      );

    const minimumWithdraw =
      minimumWithdrawResult.rows.length > 0
        ? Number(
            minimumWithdrawResult.rows[0].value
          )
        : 51;

    if (withdrawAmount < minimumWithdraw) {

      return res.status(400).json({
        success: false,
        message:
          `Minimum withdrawal is ${minimumWithdraw} ETB.`
      });
    }

    /*
    | Start transaction
    */

    await client.query("BEGIN");

    /*
    | Find and lock user
    */

    const userResult = await client.query(
      `
      SELECT *
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [telegram_id]
    );

    if (userResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    const user = userResult.rows[0];

    /*
    | Check account status
    */

    if (!user.is_active) {

      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        message: "User account is inactive."
      });
    }

    /*
    | Only withdraw from normal balance
    |
    | bonus_balance is NOT withdrawable.
    */

    const balance = Number(user.balance);

    if (balance < withdrawAmount) {

      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message:
          "Insufficient withdrawable balance."
      });
    }

    /*
    | Create unique withdrawal reference
    */

    const platformReference =
      `WDR-${user.id}-${Date.now()}-${Math.floor(
        Math.random() * 100000
      )}`;

    /*
    | Clean account information
    */

    const cleanAccount =
      String(account).trim();

    /*
    | Transaction description
    */

    const description =
      `${method} withdrawal request | Account: ${cleanAccount}`;

    /*
    | Reserve money immediately
    */

    const newBalance =
      Number(
        (balance - withdrawAmount).toFixed(2)
      );

    await client.query(
      `
      UPDATE users
      SET
        balance = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        newBalance,
        user.id
      ]
    );

    /*
    | Create pending withdrawal transaction
    */

    const transactionResult =
      await client.query(
        `
        INSERT INTO transactions
          (
            user_id,
            type,
            amount,
            status,
            reference,
            description
          )
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [
          user.id,
          "withdraw",
          withdrawAmount,
          "pending",
          platformReference,
          description
        ]
      );

    /*
    | Complete transaction
    */

    await client.query("COMMIT");

    res.json({
      success: true,
      message:
        "Withdrawal request submitted successfully.",
      transaction:
        transactionResult.rows[0],
      balance: newBalance
    });

  } catch (error) {

    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Withdrawal rollback error:",
        rollbackError.message
      );
    }

    console.error(
      "Withdrawal request error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message:
        "Could not create withdrawal request."
    });

  } finally {

    client.release();

  }
});

/*
|--------------------------------------------------------------------------
| Wallet Transactions
|--------------------------------------------------------------------------
*/

app.get("/api/wallet/transactions", async (req, res) => {

  try {

    const {
      telegram_id
    } = req.query;

    if (!telegram_id) {

      return res.status(400).json({
        success: false,
        message: "telegram_id is required."
      });
    }

    const result = await pool.query(
      `
      SELECT
        t.id,
        t.type,
        t.amount,
        t.status,
        t.reference,
        t.description,
        t.created_at,
        t.updated_at
      FROM transactions t
      INNER JOIN users u
        ON u.id = t.user_id
      WHERE u.telegram_id = $1
      ORDER BY t.created_at DESC
      LIMIT 100
      `,
      [telegram_id]
    );

    res.json({
      success: true,
      transactions: result.rows
    });

  } catch (error) {

    console.error(
      "Wallet transactions error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message:
        "Could not load wallet transactions."
    });
  }
});

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {

  console.log(
    `Client connected: ${socket.id}`
  );

  socket.emit("serverMessage", {
    message:
      "Connected to Ethiopia Betting server."
  });

  socket.on("disconnect", () => {

    console.log(
      `Client disconnected: ${socket.id}`
    );

  });

});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

async function startServer() {

  try {

    await initializeDatabase();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `Ethiopia Betting server running on port ${PORT}`
        );

      }
    );

  } catch (error) {

    console.error(
      "❌ Server startup failed."
    );

    process.exit(1);
  }
}

startServer();
