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

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_URL = "https://v3.football.api-sports.io";

const FOOTBALL_TIMEZONE = "Africa/Addis_Ababa";

/*
|--------------------------------------------------------------------------
| App
|--------------------------------------------------------------------------
*/

const app = express();
const server = http.createServer(app);

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/

const io = new Server(server, {
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

const PORT = process.env.PORT || 10000;

/*
|--------------------------------------------------------------------------
| PostgreSQL
|--------------------------------------------------------------------------
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

pool.on("error", (err) => {
  console.error(
    "PostgreSQL pool error:",
    err.message
  );
});

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(cors());

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/*
|--------------------------------------------------------------------------
| Database Initialization
|--------------------------------------------------------------------------
*/

async function initializeDatabase() {
  try {
    const schemaPath = path.join(
      __dirname,
      "schema.sql"
    );

    if (!fs.existsSync(schemaPath)) {
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

    await pool.query(schema);

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
        message:
          "Could not read database tables."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| User Account
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
      | New user
      |
      | Signup bonus is stored in bonus_balance.
      | It is NOT directly withdrawable.
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
| User Test
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
        user: result.rows[0]
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
| FOOTBALL API
|--------------------------------------------------------------------------
*/

/*
| API request helper
*/

async function footballRequest(
  endpoint,
  params = {}
) {

  if (!API_FOOTBALL_KEY) {
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
    url
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          "x-apisports-key":
            API_FOOTBALL_KEY,
          "Accept":
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
| Date Helper
|--------------------------------------------------------------------------
|
| Uses Ethiopia/Addis Ababa date.
|
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
        p => p.type === "year"
      ).value
    );

  const month =
    Number(
      parts.find(
        p => p.type === "month"
      ).value
    );

  const day =
    Number(
      parts.find(
        p => p.type === "day"
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

/*
|--------------------------------------------------------------------------
| Date Validation
|--------------------------------------------------------------------------
*/

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
    date.toISOString().slice(0, 10) ===
      value
  );
}

/*
|--------------------------------------------------------------------------
| Football Diagnostic
|--------------------------------------------------------------------------
|
| IMPORTANT:
| Free API-Football does NOT support "next".
|
| Example:
| /api/football/diagnostic
| /api/football/diagnostic?date=2026-10-06
|
*/

app.get(
  "/api/football/diagnostic",
  async (req, res) => {

    try {

      const date =
        req.query.date ||
        getAddisDate(0);

      if (
        !isValidDateString(date)
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid date. Use YYYY-MM-DD."
        });

      }

      const result =
        await footballRequest(
          "fixtures",
          {
            date,
            timezone:
              FOOTBALL_TIMEZONE
          }
        );

      const data =
        result.data;

      res.json({

        success:
          result.ok,

        http_status:
          result.http_status,

        api: {

          endpoint:
            data?.get ||
            "fixtures",

          parameters:
            data?.parameters ||
            {},

          errors:
            data?.errors ||
            {},

          results:
            data?.results ||
            0,

          paging:
            data?.paging ||
            {}

        },

        date,

        matches:
          Array.isArray(
            data?.response
          )
            ? data.response
            : []

      });

    } catch (error) {

      console.error(
        "Football diagnostic error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Failed to connect to API-Football.",

        error:
          error.message

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Football Fixtures Test
|--------------------------------------------------------------------------
|
| Example:
| /api/football/test
| /api/football/test?date=2026-10-06
|
*/

app.get(
  "/api/football/test",
  async (req, res) => {

    try {

      const date =
        req.query.date ||
        getAddisDate(0);

      if (
        !isValidDateString(date)
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid date. Use YYYY-MM-DD."
        });

      }

      const result =
        await footballRequest(
          "fixtures",
          {
            date,
            timezone:
              FOOTBALL_TIMEZONE
          }
        );

      const data =
        result.data;

      res.json({

        success:
          result.ok,

        http_status:
          result.http_status,

        date,

        errors:
          data?.errors ||
          {},

        results:
          data?.results ||
          0,

        paging:
          data?.paging ||
          {},

        response:
          Array.isArray(
            data?.response
          )
            ? data.response
            : []

      });

    } catch (error) {

      console.error(
        "API-Football test error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Failed to connect to API-Football.",

        error:
          error.message

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Football Odds By Fixture
|--------------------------------------------------------------------------
|
| Example:
| /api/football/odds/1549809
|
*/

app.get(
  "/api/football/odds/:fixtureId",
  async (req, res) => {

    try {

      const fixtureId =
        Number(
          req.params.fixtureId
        );

      if (
        !Number.isInteger(
          fixtureId
        ) ||
        fixtureId <= 0
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid fixture ID."
        });

      }

      const result =
        await footballRequest(
          "odds",
          {
            fixture:
              fixtureId
          }
        );

      const data =
        result.data;

      res.json({

        success:
          result.ok,

        http_status:
          result.http_status,

        fixture_id:
          fixtureId,

        errors:
          data?.errors ||
          {},

        results:
          data?.results ||
          0,

        paging:
          data?.paging ||
          {},

        response:
          Array.isArray(
            data?.response
          )
            ? data.response
            : []

      });

    } catch (error) {

      console.error(
        "Fixture odds error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Failed to load fixture odds.",

        error:
          error.message

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Football Odds By Date
|--------------------------------------------------------------------------
|
| Free plan supports date.
|
| Example:
| /api/football/odds-test
| /api/football/odds-test?date=2026-10-06
|
| NOTE:
| Odds availability depends on the API-Football plan,
| bookmaker coverage and fixture.
|
*/

app.get(
  "/api/football/odds-test",
  async (req, res) => {

    try {

      const date =
        req.query.date ||
        getAddisDate(0);

      if (
        !isValidDateString(date)
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid date. Use YYYY-MM-DD."
        });

      }

      const result =
        await footballRequest(
          "odds",
          {
            date
          }
        );

      const data =
        result.data;

      res.json({

        success:
          result.ok,

        http_status:
          result.http_status,

        date,

        errors:
          data?.errors ||
          {},

        results:
          data?.results ||
          0,

        paging:
          data?.paging ||
          {},

        response:
          Array.isArray(
            data?.response
          )
            ? data.response
            : []

      });

    } catch (error) {

      console.error(
        "API-Football odds error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Failed to load football odds.",

        error:
          error.message

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Football Upcoming Matches
|--------------------------------------------------------------------------
|
| IMPORTANT:
| Free plan does NOT support "next".
|
| We query dates individually.
|
| Example:
| /api/football/upcoming
| /api/football/upcoming?days=3
| /api/football/upcoming?date=2026-10-06&days=3
|
|--------------------------------------------------------------------------
*/

app.get(
  "/api/football/upcoming",
  async (req, res) => {

    try {

      const requestedDays =
        Number(
          req.query.days
        );

      const days =
        Number.isFinite(
          requestedDays
        )
          ? Math.min(
              Math.max(
                Math.floor(
                  requestedDays
                ),
                1
              ),
              4
            )
          : 3;

      const startDate =
        req.query.date ||
        getAddisDate(0);

      if (
        !isValidDateString(
          startDate
        )
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid date. Use YYYY-MM-DD."
        });

      }

      const allMatches = [];
      const apiErrors = [];

      /*
      | Query each date separately.
      |
      | Maximum 4 dates to protect
      | the free API quota.
      */

      for (
        let i = 0;
        i < days;
        i++
      ) {

        const date =
          i === 0
            ? startDate
            : getDateFromString(
                startDate,
                i
              );

        try {

          const result =
            await footballRequest(
              "fixtures",
              {
                date,
                timezone:
                  FOOTBALL_TIMEZONE
              }
            );

          const data =
            result.data;

          if (
            data?.errors &&
            Object.keys(
              data.errors
            ).length > 0
          ) {

            apiErrors.push({
              date,
              errors:
                data.errors
            });

          }

          const matches =
            Array.isArray(
              data?.response
            )
              ? data.response
              : [];

          for (
            const match
            of matches
          ) {

            const status =
              match?.fixture
                ?.status
                ?.short;

            /*
            | Keep scheduled/live matches.
            | Exclude finished/cancelled.
            */

            const allowedStatuses = [
              "NS",
              "TBD",
              "1H",
              "HT",
              "2H",
              "ET",
              "P",
              "BT",
              "LIVE"
            ];

            if (
              allowedStatuses.includes(
                status
              )
            ) {

              allMatches.push(
                match
              );

            }

          }

        } catch (error) {

          apiErrors.push({
            date,
            error:
              error.message
          });

        }

      }

      /*
      | Sort by match date.
      */

      allMatches.sort(
        (a, b) => {

          const dateA =
            new Date(
              a?.fixture?.date ||
              0
            ).getTime();

          const dateB =
            new Date(
              b?.fixture?.date ||
              0
            ).getTime();

          return dateA - dateB;

        }
      );

      res.json({

        success:
          true,

        start_date:
          startDate,

        days,

        dates_checked:
          Array.from(
            {
              length: days
            },
            (_, i) =>
              i === 0
                ? startDate
                : getDateFromString(
                    startDate,
                    i
                  )
          ),

        results:
          allMatches.length,

        errors:
          apiErrors,

        matches:
          allMatches

      });

    } catch (error) {

      console.error(
        "Upcoming football error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Failed to load upcoming matches.",

        error:
          error.message

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Date From String Helper
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| Football Matches With Limited Odds
|--------------------------------------------------------------------------
|
| This endpoint is useful for the Betting page.
|
| It:
|
| 1. Gets fixtures for selected dates.
| 2. Selects a limited number of matches.
| 3. Gets odds for those matches.
|
| This is intentionally limited because the free
| API plan has request limits.
|
| Example:
| /api/football/betting?days=1&limit=5
|
|--------------------------------------------------------------------------
*/

app.get(
  "/api/football/betting",
  async (req, res) => {

    try {

      const requestedDays =
        Number(
          req.query.days
        );

      const days =
        Number.isFinite(
          requestedDays
        )
          ? Math.min(
              Math.max(
                Math.floor(
                  requestedDays
                ),
                1
              ),
              2
            )
          : 1;

      const requestedLimit =
        Number(
          req.query.limit
        );

      const limit =
        Number.isFinite(
          requestedLimit
        )
          ? Math.min(
              Math.max(
                Math.floor(
                  requestedLimit
                ),
                1
              ),
              10
            )
          : 5;

      const startDate =
        req.query.date ||
        getAddisDate(0);

      if (
        !isValidDateString(
          startDate
        )
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid date. Use YYYY-MM-DD."
        });

      }

      const fixtures = [];

      /*
      | Get fixtures by date.
      */

      for (
        let i = 0;
        i < days;
        i++
      ) {

        const date =
          i === 0
            ? startDate
            : getDateFromString(
                startDate,
                i
              );

        const result =
          await footballRequest(
            "fixtures",
            {
              date,
              timezone:
                FOOTBALL_TIMEZONE
            }
          );

        const data =
          result.data;

        if (
          !Array.isArray(
            data?.response
          )
        ) {
          continue;
        }

        for (
          const fixture
          of data.response
        ) {

          const status =
            fixture?.fixture
              ?.status
              ?.short;

          const allowedStatuses = [
            "NS",
            "TBD",
            "1H",
            "HT",
            "2H",
            "ET",
            "P",
            "BT",
            "LIVE"
          ];

          if (
            allowedStatuses.includes(
              status
            )
          ) {

            fixtures.push(
              fixture
            );

          }

        }

      }

      /*
      | Sort fixtures.
      */

      fixtures.sort(
        (a, b) => {

          return (
            new Date(
              a?.fixture?.date ||
              0
            ).getTime()
            -
            new Date(
              b?.fixture?.date ||
              0
            ).getTime()
          );

        }
      );

      /*
      | Only inspect a limited number.
      */

      const selectedFixtures =
        fixtures.slice(
          0,
          limit
        );

      const matches = [];

      /*
      | Request odds one fixture at a time.
      |
      | Limited intentionally.
      */

      for (
        const fixture
        of selectedFixtures
      ) {

        const fixtureId =
          fixture?.fixture?.id;

        if (!fixtureId) {
          continue;
        }

        try {

          const oddsResult =
            await footballRequest(
              "odds",
              {
                fixture:
                  fixtureId
              }
            );

          const oddsData =
            oddsResult.data;

          matches.push({

            fixture:
              fixture,

            fixture_id:
              fixtureId,

            odds:
              Array.isArray(
                oddsData?.response
              )
                ? oddsData.response
                : [],

            odds_results:
              oddsData?.results ||
              0,

            odds_errors:
              oddsData?.errors ||
              {}

          });

        } catch (error) {

          matches.push({

            fixture:
              fixture,

            fixture_id:
              fixtureId,

            odds: [],

            odds_results:
              0,

            odds_errors: {
              request:
                error.message
            }

          });

        }

      }

      res.json({

        success: true,

        start_date:
          startDate,

        days,

        fixtures_found:
          fixtures.length,

        fixtures_checked:
          selectedFixtures.length,

        matches

      });

    } catch (error) {

      console.error(
        "Football betting API error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Failed to load football betting data.",

        error:
          error.message

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Local Matches
|--------------------------------------------------------------------------
*/

app.get(
  "/api/matches",
  async (req, res) => {

    try {

      const result =
        await pool.query(`
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
          ORDER BY
            started_at ASC NULLS LAST,
            id ASC
        `);

      res.json({
        success: true,
        matches:
          result.rows
      });

    } catch (error) {

      console.error(
        "Get matches error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load matches."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Get One Local Match
|--------------------------------------------------------------------------
*/

app.get(
  "/api/matches/:id",
  async (req, res) => {

    try {

      const { id } =
        req.params;

      const result =
        await pool.query(
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

      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({
          success: false,
          message:
            "Match not found."
        });

      }

      res.json({
        success: true,
        match:
          result.rows[0]
      });

    } catch (error) {

      console.error(
        "Get match error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to load match."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Betting - Place Bet
|--------------------------------------------------------------------------
*/

app.post(
  "/api/bets/place",
  async (req, res) => {

    const client =
      await pool.connect();

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
          message:
            "telegram_id is required."
        });

      }

      if (!game) {

        return res.status(400).json({
          success: false,
          message:
            "game is required."
        });

      }

      if (
        !Array.isArray(
          selections
        ) ||
        selections.length === 0
      ) {

        return res.status(400).json({
          success: false,
          message:
            "At least one selection is required."
        });

      }

      const amount =
        Number(stake);

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid stake amount."
        });

      }

      await client.query(
        "BEGIN"
      );

      const userResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegram_id]
        );

      if (
        userResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message:
            "User not found."
        });

      }

      const user =
        userResult.rows[0];

      if (!user.is_active) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(403).json({
          success: false,
          message:
            "User account is inactive."
        });

      }

      const balance =
        Number(user.balance);

      if (
        balance < amount
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          success: false,
          message:
            "Insufficient balance."
        });

      }

      /*
      | Calculate total odds
      */

      let totalOdds = 1;

      for (
        const selection
        of selections
      ) {

        const odd =
          Number(
            selection.odd
          );

        if (
          !Number.isFinite(
            odd
          ) ||
          odd <= 1
        ) {

          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            success: false,
            message:
              "Invalid odds."
          });

        }

        totalOdds *= odd;

      }

      totalOdds =
        Number(
          totalOdds.toFixed(4)
        );

      const potentialWin =
        Number(
          (
            amount *
            totalOdds
          ).toFixed(2)
        );

      /*
      | Store bet
      */

      const betResult =
        await client.query(
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
              total_odds:
                totalOdds
            })
          ]
        );

      /*
      | Deduct stake
      */

      const newBalance =
        Number(
          (
            balance -
            amount
          ).toFixed(2)
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
      | Transaction
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
          "bet",
          amount,
          "completed",
          `BET-${betResult.rows[0].id}`,
          `${game} betting stake`
        ]
      );

      await client.query(
        "COMMIT"
      );

      res.json({

        success: true,

        message:
          "Bet placed successfully.",

        bet:
          betResult.rows[0],

        balance:
          newBalance

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (
        rollbackError
      ) {

        console.error(
          "Rollback error:",
          rollbackError.message
        );

      }

      console.error(
        "Place bet error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Could not place bet."
      });

    } finally {

      client.release();

    }

  }
);

/*
|--------------------------------------------------------------------------
| TEST ONLY - Automatic Settlement
|--------------------------------------------------------------------------
|
| IMPORTANT:
| Random settlement is ONLY for development/testing.
| NEVER use this endpoint in production.
|
|--------------------------------------------------------------------------
*/

app.post(
  "/api/test/settle-bet",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const requestedBetId =
        req.body &&
        req.body.bet_id
          ? Number(
              req.body.bet_id
            )
          : null;

      await client.query(
        "BEGIN"
      );

      let betResult;

      if (
        requestedBetId &&
        Number.isInteger(
          requestedBetId
        ) &&
        requestedBetId > 0
      ) {

        betResult =
          await client.query(
            `
            SELECT
              b.*,
              u.telegram_id,
              u.balance
            FROM bets b
            INNER JOIN users u
              ON u.id = b.user_id
            WHERE
              b.id = $1
              AND b.status = 'pending'
            FOR UPDATE OF b
            `,
            [requestedBetId]
          );

      } else {

        betResult =
          await client.query(
            `
            SELECT
              b.*,
              u.telegram_id,
              u.balance
            FROM bets b
            INNER JOIN users u
              ON u.id = b.user_id
            WHERE
              b.status = 'pending'
            ORDER BY
              b.id ASC
            LIMIT 1
            FOR UPDATE OF b
            `
          );

      }

      if (
        betResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message:
            "No pending bet found."
        });

      }

      const bet =
        betResult.rows[0];

      const userResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [bet.user_id]
        );

      if (
        userResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message:
            "Bet user not found."
        });

      }

      const user =
        userResult.rows[0];

      /*
      | TEST ONLY
      */

      const randomResult =
        crypto.randomInt(
          0,
          2
        );

      const won =
        randomResult === 1;

      const status =
        won
          ? "won"
          : "lost";

      const actualWin =
        won
          ? Number(
              bet.potential_win
            )
          : 0;

      const currentBalance =
        Number(
          user.balance
        );

      const newBalance =
        won
          ? Number(
              (
                currentBalance +
                actualWin
              ).toFixed(2)
            )
          : currentBalance;

      const resultData = {
        test_mode: true,
        outcome:
          status,
        settled_by:
          "automatic_test_settlement",
        settled_at:
          new Date().toISOString()
      };

      await client.query(
        `
        UPDATE bets
        SET
          actual_win = $1,
          status = $2,
          result =
            COALESCE(
              result,
              '{}'::jsonb
            )
            ||
            $3::jsonb,
          settled_at = NOW()
        WHERE
          id = $4
          AND status = 'pending'
        `,
        [
          actualWin,
          status,
          JSON.stringify(
            resultData
          ),
          bet.id
        ]
      );

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

      await client.query(
        "COMMIT"
      );

      res.json({

        success: true,

        message:
          won
            ? "Bet settled as WON."
            : "Bet settled as LOST.",

        bet_id:
          bet.id,

        telegram_id:
          bet.telegram_id,

        status,

        stake:
          Number(
            bet.stake
          ),

        potential_win:
          Number(
            bet.potential_win
          ),

        actual_win:
          actualWin,

        balance:
          newBalance

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (
        rollbackError
      ) {

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

  }
);

/*
|--------------------------------------------------------------------------
| Bet History
|--------------------------------------------------------------------------
*/

app.get(
  "/api/bets/history",
  async (req, res) => {

    try {

      const {
        telegram_id
      } = req.query;

      if (!telegram_id) {

        return res.status(400).json({
          success: false,
          message:
            "telegram_id is required."
        });

      }

      const result =
        await pool.query(
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
          WHERE
            u.telegram_id = $1
          ORDER BY
            b.created_at DESC
          LIMIT 50
          `,
          [telegram_id]
        );

      res.json({
        success: true,
        bets:
          result.rows
      });

    } catch (error) {

      console.error(
        "Bet history error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Could not load bet history."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| Deposit Request
|--------------------------------------------------------------------------
*/

app.post(
  "/api/deposit/request",
  async (req, res) => {

    const client =
      await pool.connect();

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
          message:
            "telegram_id is required."
        });

      }

      const depositAmount =
        Number(amount);

      if (
        !Number.isFinite(
          depositAmount
        ) ||
        depositAmount <= 0
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid deposit amount."
        });

      }

      if (!method) {

        return res.status(400).json({
          success: false,
          message:
            "Payment method is required."
        });

      }

      const minimumDepositResult =
        await pool.query(
          `
          SELECT value
          FROM settings
          WHERE key =
            'minimum_deposit'
          `
        );

      const minimumDeposit =
        minimumDepositResult.rows.length > 0
          ? Number(
              minimumDepositResult
                .rows[0]
                .value
            )
          : 51;

      if (
        depositAmount <
        minimumDeposit
      ) {

        return res.status(400).json({
          success: false,
          message:
            `Minimum deposit is ${minimumDeposit} ETB.`
        });

      }

      await client.query(
        "BEGIN"
      );

      const userResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegram_id]
        );

      if (
        userResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message:
            "User not found."
        });

      }

      const user =
        userResult.rows[0];

      if (!user.is_active) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(403).json({
          success: false,
          message:
            "User account is inactive."
        });

      }

      const cleanReference =
        reference &&
        String(
          reference
        ).trim()
          ? String(
              reference
            ).trim()
          : null;

      const platformReference =
        `DEP-${user.id}-${Date.now()}-${crypto.randomInt(
          100000,
          999999
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

      await client.query(
        "COMMIT"
      );

      res.json({

        success: true,

        message:
          "Deposit request submitted successfully.",

        transaction:
          transactionResult.rows[0]

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (
        rollbackError
      ) {

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

  }
);

/*
|--------------------------------------------------------------------------
| Withdraw Request
|--------------------------------------------------------------------------
*/

app.post(
  "/api/withdraw/request",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const {
        telegram_id,
        amount,
        method,
        account
      } = req.body;

      if (!telegram_id) {

        return res.status(400).json({
          success: false,
          message:
            "telegram_id is required."
        });

      }

      const withdrawAmount =
        Number(amount);

      if (
        !Number.isFinite(
          withdrawAmount
        ) ||
        withdrawAmount <= 0
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal amount."
        });

      }

      if (!method) {

        return res.status(400).json({
          success: false,
          message:
            "Withdrawal method is required."
        });

      }

      if (
        !account ||
        !String(
          account
        ).trim()
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Withdrawal account is required."
        });

      }

      const minimumWithdrawResult =
        await pool.query(
          `
          SELECT value
          FROM settings
          WHERE key =
            'minimum_withdraw'
          `
        );

      const minimumWithdraw =
        minimumWithdrawResult.rows.length > 0
          ? Number(
              minimumWithdrawResult
                .rows[0]
                .value
            )
          : 51;

      if (
        withdrawAmount <
        minimumWithdraw
      ) {

        return res.status(400).json({
          success: false,
          message:
            `Minimum withdrawal is ${minimumWithdraw} ETB.`
        });

      }

      await client.query(
        "BEGIN"
      );

      const userResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegram_id]
        );

      if (
        userResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message:
            "User not found."
        });

      }

      const user =
        userResult.rows[0];

      if (!user.is_active) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(403).json({
          success: false,
          message:
            "User account is inactive."
        });

      }

      /*
      | Only normal balance is withdrawable.
      */

      const balance =
        Number(
          user.balance
        );

      if (
        balance <
        withdrawAmount
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          success: false,
          message:
            "Insufficient withdrawable balance."
        });

      }

      const platformReference =
        `WDR-${user.id}-${Date.now()}-${crypto.randomInt(
          100000,
          999999
        )}`;

      const cleanAccount =
        String(
          account
        ).trim();

      const description =
        `${method} withdrawal request | Account: ${cleanAccount}`;

      const newBalance =
        Number(
          (
            balance -
            withdrawAmount
          ).toFixed(2)
        );

      /*
      | Reserve withdrawal money
      */

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

      await client.query(
        "COMMIT"
      );

      res.json({

        success: true,

        message:
          "Withdrawal request submitted successfully.",

        transaction:
          transactionResult.rows[0],

        balance:
          newBalance

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (
        rollbackError
      ) {

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

  }
);

/*
|--------------------------------------------------------------------------
| Wallet Transactions
|--------------------------------------------------------------------------
*/

app.get(
  "/api/wallet/transactions",
  async (req, res) => {

    try {

      const {
        telegram_id
      } = req.query;

      if (!telegram_id) {

        return res.status(400).json({
          success: false,
          message:
            "telegram_id is required."
        });

      }

      const result =
        await pool.query(
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
          WHERE
            u.telegram_id = $1
          ORDER BY
            t.created_at DESC
          LIMIT 100
          `,
          [telegram_id]
        );

      res.json({
        success: true,
        transactions:
          result.rows
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

  }
);

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/

io.on(
  "connection",
  (socket) => {

    console.log(
      `Client connected: ${socket.id}`
    );

    socket.emit(
      "serverMessage",
      {
        message:
          "Connected to Ethiopia Betting server."
      }
    );

    socket.on(
      "disconnect",
      () => {

        console.log(
          `Client disconnected: ${socket.id}`
        );

      }
    );

  }
);

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
