const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

/*
|--------------------------------------------------------------------------
| API-Football
|--------------------------------------------------------------------------
*/

const API_FOOTBALL_KEY =
  process.env.API_FOOTBALL_KEY;

const API_FOOTBALL_URL =
  "https://v3.football.api-sports.io";

const FOOTBALL_TIMEZONE =
  "Africa/Addis_Ababa";

/*
|--------------------------------------------------------------------------
| App
|--------------------------------------------------------------------------
*/

const app = express();

const server =
  http.createServer(app);

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/

const io =
  new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

/*
|--------------------------------------------------------------------------
| Port
|--------------------------------------------------------------------------
*/

const PORT =
  process.env.PORT || 10000;

/*
|--------------------------------------------------------------------------
| PostgreSQL
|--------------------------------------------------------------------------
*/

const pool =
  new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl:
      process.env.NODE_ENV === "production"
        ? {
            rejectUnauthorized: false
          }
        : false
  });

pool.on(
  "error",
  (err) => {
    console.error(
      "PostgreSQL pool error:",
      err.message
    );
  }
);

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(cors());

app.use(
  express.json()
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/*
|--------------------------------------------------------------------------
| Database Initialization
|--------------------------------------------------------------------------
*/

async function initializeDatabase() {

  try {

    const schemaPath =
      path.join(
        __dirname,
        "schema.sql"
      );

    if (
      !fs.existsSync(
        schemaPath
      )
    ) {

      console.log(
        "⚠️ schema.sql not found."
      );

      return;
    }

    const schema =
      fs.readFileSync(
        schemaPath,
        "utf8"
      );

    await pool.query(
      schema
    );

    console.log(
      "✅ Database tables initialized successfully."
    );

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

app.get(
  "/",
  (req, res) => {

    res.json({
      success: true,
      name: "Ethiopia Betting",
      status: "online"
    });

  }
);

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get(
  "/api/health",
  async (req, res) => {

    try {

      const result =
        await pool.query(
          "SELECT NOW() AS time"
        );

      res.json({
        success: true,
        server: "healthy",
        database: "healthy",
        time:
          result.rows[0].time
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

  }
);

/*
|--------------------------------------------------------------------------
| Database Test
|--------------------------------------------------------------------------
*/

app.get(
  "/api/database-test",
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT
            current_database() AS database,
            current_user AS user
        `);

      res.json({
        success: true,
        message:
          "PostgreSQL connection successful.",
        database:
          result.rows[0].database,
        user:
          result.rows[0].user
      });

    } catch (error) {

      console.error(
        "Database connection error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Database connection failed."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Tables Test
|--------------------------------------------------------------------------
*/

app.get(
  "/api/tables-test",
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
          ORDER BY table_name
        `);

      res.json({
        success: true,
        tables:
          result.rows.map(
            row =>
              row.table_name
          )
      });

    } catch (error) {

      console.error(
        "Tables test error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Could not read database tables."
      });

    }

  }
);
/*
|--------------------------------------------------------------------------
| USER ACCOUNT
|--------------------------------------------------------------------------
*/

app.post(
  "/api/user",
  async (req, res) => {

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
          message:
            "telegram_id is required."
        });

      }

      const existingUser =
        await pool.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          `,
          [telegram_id]
        );

      if (
        existingUser.rows.length > 0
      ) {

        return res.json({
          success: true,
          new_user: false,
          user:
            existingUser.rows[0]
        });

      }

      /*
      |--------------------------------------------------------------------------
      | Signup Bonus
      |--------------------------------------------------------------------------
      |
      | 50 ETB bonus is stored separately.
      | It is NOT withdrawable directly.
      |
      */

      const signupBonus = 50.00;

      const result =
        await pool.query(
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
            0,
            signupBonus
          ]
        );

      const user =
        result.rows[0];

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
        message:
          "Account created successfully.",
        user
      });

    } catch (error) {

      console.error(
        "User account error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Could not create user account."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| USER TEST
|--------------------------------------------------------------------------
*/

app.get(
  "/api/user-test",
  async (req, res) => {

    try {

      const telegramId =
        "TEST_USER_001";

      let result =
        await pool.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          `,
          [telegramId]
        );

      if (
        result.rows.length === 0
      ) {

        const signupBonus = 50.00;

        result =
          await pool.query(
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
              0,
              signupBonus
            ]
          );

        const user =
          result.rows[0];

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

      res.json({
        success: true,
        new_user: false,
        user:
          result.rows[0]
      });

    } catch (error) {

      console.error(
        "User test error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "User test failed."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| API-FOOTBALL REQUEST HELPER
|--------------------------------------------------------------------------
*/

async function footballRequest(
  endpoint,
  params = {}
) {

  if (
    !API_FOOTBALL_KEY
  ) {

    throw new Error(
      "API_FOOTBALL_KEY is not configured."
    );

  }

  const query =
    new URLSearchParams();

  for (
    const [key, value]
    of Object.entries(params)
  ) {

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {

      query.append(
        key,
        String(value)
      );

    }

  }

  const url =
    `${API_FOOTBALL_URL}/${endpoint}?${query.toString()}`;

  console.log(
    "⚽ API-Football request:",
    endpoint,
    params
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          "x-apisports-key":
            API_FOOTBALL_KEY,
          Accept:
            "application/json"
        }
      }
    );

  let data;

  try {

    data =
      await response.json();

  } catch (error) {

    data = {
      errors: {
        parse:
          "API returned invalid JSON."
      }
    };

  }

  return {
    http_status:
      response.status,

    ok:
      response.ok,

    data
  };
}

/*
|--------------------------------------------------------------------------
| DATE HELPERS
|--------------------------------------------------------------------------
*/

function getAddisDate(
  offsetDays = 0
) {

  const now =
    new Date();

  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          FOOTBALL_TIMEZONE,
        year:
          "numeric",
        month:
          "2-digit",
        day:
          "2-digit"
      }
    ).formatToParts(now);

  const year =
    Number(
      parts.find(
        p =>
          p.type === "year"
      ).value
    );

  const month =
    Number(
      parts.find(
        p =>
          p.type === "month"
      ).value
    );

  const day =
    Number(
      parts.find(
        p =>
          p.type === "day"
      ).value
    );

  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day + offsetDays
      )
    );

  return date
    .toISOString()
    .slice(0, 10);
}

function getDateFromString(
  dateString,
  offsetDays
) {

  const base =
    new Date(
      `${dateString}T00:00:00Z`
    );

  base.setUTCDate(
    base.getUTCDate() +
      offsetDays
  );

  return base
    .toISOString()
    .slice(0, 10);
}

function isValidDateString(
  value
) {

  if (
    typeof value !==
    "string"
  ) {

    return false;
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      value
    )
  ) {

    return false;
  }

  const date =
    new Date(
      `${value}T00:00:00Z`
    );

  return (
    !Number.isNaN(
      date.getTime()
    ) &&
    date
      .toISOString()
      .slice(0, 10) ===
      value
  );
}
