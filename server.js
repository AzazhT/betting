const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

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
    console.error("❌ Database initialization failed:", error.message);
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
    const result = await pool.query("SELECT NOW() AS time");

    res.json({
      success: true,
      server: "healthy",
      database: "healthy",
      time: result.rows[0].time
    });

  } catch (error) {
    console.error("Health check error:", error.message);

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
    console.error("Database connection error:", error.message);

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
      tables: result.rows.map(row => row.table_name)
    });

  } catch (error) {
    console.error("Tables test error:", error.message);

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

    console.error("User account error:", error.message);

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

    console.error("User test error:", error.message);

    res.status(500).json({
      success: false,
      message: "User test failed."
    });
  }
});
/*
|--------------------------------------------------------------------------
| Betting
|--------------------------------------------------------------------------
*/

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

    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one selection is required."
      });
    }

    const amount = Number(stake);

    if (!Number.isFinite(amount) || amount <= 0) {
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

    totalOdds = Number(totalOdds.toFixed(4));

    const potentialWin =
      Number((amount * totalOdds).toFixed(2));

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
      Number((balance - amount).toFixed(2));

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
| Socket.IO
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {

  console.log(`Client connected: ${socket.id}`);

  socket.emit("serverMessage", {
    message: "Connected to Ethiopia Betting server."
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
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

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `Ethiopia Betting server running on port ${PORT}`
      );
    });

  } catch (error) {

    console.error("❌ Server startup failed.");

    process.exit(1);
  }
}

startServer();
