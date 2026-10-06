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

/*
|--------------------------------------------------------------------------
| FOOTBALL DIAGNOSTIC
|--------------------------------------------------------------------------
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
          "Failed to connect to API-Football."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| FOOTBALL FIXTURES TEST
|--------------------------------------------------------------------------
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
          "Failed to connect to API-Football."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| FOOTBALL ODDS BY FIXTURE
|--------------------------------------------------------------------------
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
        !Number.isInteger(fixtureId) ||
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
          "Failed to load fixture odds."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| ODDS BY DATE
|--------------------------------------------------------------------------
|
| IMPORTANT:
| Free API-Football plan can return
| odds by date even when individual
| fixture requests return no odds.
|
|--------------------------------------------------------------------------
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
          "Failed to load football odds."
      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| NORMALIZE ODDS
|--------------------------------------------------------------------------
|
| Converts API-Football bookmaker
| data into simple frontend markets.
|--------------------------------------------------------------------------
*/

function normalizeOdds(
  oddsResponse
) {

  const markets = {
    "1x2": [],
    double: [],
    overunder: [],
    btts: [],
    handicap: []
  };

  if (
    !Array.isArray(
      oddsResponse
    )
  ) {

    return markets;
  }

  /*
  |--------------------------------------------------------------------------
  | Helper
  |--------------------------------------------------------------------------
  */

  function addMarket(
    marketKey,
    name,
    value,
    odd,
    extra = {}
  ) {

    const numericOdd =
      Number(odd);

    if (
      !Number.isFinite(
        numericOdd
      ) ||
      numericOdd <= 1
    ) {

      return;
    }

    markets[marketKey].push({

      name,

      value,

      odd:
        numericOdd,

      ...extra

    });

  }

  /*
  |--------------------------------------------------------------------------
  | API-Football odds structure
  |--------------------------------------------------------------------------
  */

  for (
    const bookmakerResponse
    of oddsResponse
  ) {

    const bookmakers =
      Array.isArray(
        bookmakerResponse?.bookmakers
      )
        ? bookmakerResponse.bookmakers
        : [];

    for (
      const bookmaker
      of bookmakers
    ) {

      const bets =
        Array.isArray(
          bookmaker?.bets
        )
          ? bookmaker.bets
          : [];

      for (
        const bet
        of bets
      ) {

        const betName =
          String(
            bet?.name ||
            ""
          ).toLowerCase();

        const values =
          Array.isArray(
            bet?.values
          )
            ? bet.values
            : [];

        /*
        |--------------------------------------------------------------------------
        | Match Winner / 1X2
        |--------------------------------------------------------------------------
        */

        if (
          betName.includes(
            "match winner"
          )
        ) {

          for (
            const item
            of values
          ) {

            addMarket(
              "1x2",
              item?.value,
              item?.value,
              item?.odd
            );

          }

        }

        /*
        |--------------------------------------------------------------------------
        | Double Chance
        |--------------------------------------------------------------------------
        */

        if (
          betName.includes(
            "double chance"
          )
        ) {

          for (
            const item
            of values
          ) {

            addMarket(
              "double",
              item?.value,
              item?.value,
              item?.odd
            );

          }

        }

        /*
        |--------------------------------------------------------------------------
        | Over / Under
        |--------------------------------------------------------------------------
        */

        if (
          betName.includes(
            "over/under"
          ) ||
          betName.includes(
            "over under"
          )
        ) {

          for (
            const item
            of values
          ) {

            addMarket(
              "overunder",
              item?.value,
              item?.value,
              item?.odd,
              {
                line:
                  item?.handicap ||
                  null
              }
            );

          }

        }

        /*
        |--------------------------------------------------------------------------
        | Both Teams To Score
        |--------------------------------------------------------------------------
        */

        if (
          betName.includes(
            "both teams to score"
          )
        ) {

          for (
            const item
            of values
          ) {

            addMarket(
              "btts",
              item?.value,
              item?.value,
              item?.odd
            );

          }

        }

        /*
        |--------------------------------------------------------------------------
        | Handicap
        |--------------------------------------------------------------------------
        */

        if (
          betName.includes(
            "handicap"
          ) &&
          !betName.includes(
            "asian"
          )
        ) {

          for (
            const item
            of values
          ) {

            addMarket(
              "handicap",
              item?.value,
              item?.value,
              item?.odd,
              {
                line:
                  item?.handicap ||
                  null
              }
            );

          }

        }

      }

    }

    /*
    |--------------------------------------------------------------------------
    | Stop once useful markets
    | are found.
    |--------------------------------------------------------------------------
    */

    const hasUsefulMarket =
      Object.values(
        markets
      ).some(
        market =>
          market.length > 0
      );

    if (
      hasUsefulMarket
    ) {

      break;

    }

  }

  /*
  |--------------------------------------------------------------------------
  | Remove duplicates
  |--------------------------------------------------------------------------
  */

  for (
    const key
    of Object.keys(
      markets
    )
  ) {

    const seen =
      new Set();

    markets[key] =
      markets[key].filter(
        item => {

          const identifier =
            JSON.stringify([
              item.name,
              item.value,
              item.line,
              item.odd
            ]);

          if (
            seen.has(
              identifier
            )
          ) {

            return false;
          }

          seen.add(
            identifier
          );

          return true;

        }
      );

  }

  return markets;

}
/*
|--------------------------------------------------------------------------
| SAVE / UPDATE MATCH
|--------------------------------------------------------------------------
*/

async function saveMatchToDatabase(
  fixture
) {

  if (!fixture?.fixture?.id) {
    return null;
  }

  const fixtureId =
    String(fixture.fixture.id);

  const homeTeam =
    fixture.teams?.home?.name ||
    "Home";

  const awayTeam =
    fixture.teams?.away?.name ||
    "Away";

  const status =
    fixture.fixture?.status?.short ||
    "NS";

  const homeScore =
    Number.isInteger(
      fixture.goals?.home
    )
      ? fixture.goals.home
      : null;

  const awayScore =
    Number.isInteger(
      fixture.goals?.away
    )
      ? fixture.goals.away
      : null;

  let matchStatus =
    "scheduled";

  if (
    [
      "1H",
      "HT",
      "2H",
      "ET",
      "BT",
      "P"
    ].includes(status)
  ) {

    matchStatus =
      "live";

  } else if (
    [
      "FT",
      "AET",
      "PEN"
    ].includes(status)
  ) {

    matchStatus =
      "finished";

  } else if (
    [
      "PST",
      "CANC",
      "ABD",
      "AWD",
      "WO"
    ].includes(status)
  ) {

    matchStatus =
      "cancelled";

  }

  const result =
    matchStatus === "finished" &&
    homeScore !== null &&
    awayScore !== null
      ? (
          homeScore > awayScore
            ? "HOME"
            : homeScore < awayScore
              ? "AWAY"
              : "DRAW"
        )
      : null;

  const startedAt =
    fixture.fixture?.date
      ? new Date(
          fixture.fixture.date
        )
      : null;

  const finishedAt =
    matchStatus === "finished"
      ? startedAt
      : null;

  const query = `
    INSERT INTO matches
    (
      external_id,
      home_team,
      away_team,
      status,
      home_score,
      away_score,
      result,
      started_at,
      finished_at
    )
    VALUES
    (
      $1,$2,$3,$4,$5,$6,$7,$8,$9
    )
    ON CONFLICT (external_id)
    DO UPDATE SET
      home_team = EXCLUDED.home_team,
      away_team = EXCLUDED.away_team,
      status = EXCLUDED.status,
      home_score = EXCLUDED.home_score,
      away_score = EXCLUDED.away_score,
      result = EXCLUDED.result,
      started_at = EXCLUDED.started_at,
      finished_at = EXCLUDED.finished_at,
      updated_at = NOW()
    RETURNING *
  `;

  const dbResult =
    await pool.query(
      query,
      [
        fixtureId,
        homeTeam,
        awayTeam,
        matchStatus,
        homeScore,
        awayScore,
        result,
        startedAt,
        finishedAt
      ]
    );

  return dbResult.rows[0];

}

/*
|--------------------------------------------------------------------------
| FETCH FIXTURES FOR DATE
|--------------------------------------------------------------------------
*/

async function fetchFootballFixtures(
  date
) {

  const result =
    await footballRequest(
      "fixtures",
      {
        date,
        timezone:
          FOOTBALL_TIMEZONE
      }
    );

  if (
    !result.ok
  ) {

    return {
      success: false,
      fixtures: [],
      errors:
        result.data?.errors ||
        {},
      http_status:
        result.http_status
    };

  }

  const fixtures =
    Array.isArray(
      result.data?.response
    )
      ? result.data.response
      : [];

  return {
    success: true,
    fixtures,
    errors:
      result.data?.errors ||
      {},
    http_status:
      result.http_status
  };

}

/*
|--------------------------------------------------------------------------
| FETCH ODDS FOR DATE
|--------------------------------------------------------------------------
*/

async function fetchFootballOddsByDate(
  date
) {

  const result =
    await footballRequest(
      "odds",
      {
        date
      }
    );

  if (
    !result.ok
  ) {

    return {
      success: false,
      odds: [],
      errors:
        result.data?.errors ||
        {},
      http_status:
        result.http_status
    };

  }

  const odds =
    Array.isArray(
      result.data?.response
    )
      ? result.data.response
      : [];

  return {
    success: true,
    odds,
    errors:
      result.data?.errors ||
      {},
    http_status:
      result.http_status
  };

}

/*
|--------------------------------------------------------------------------
| FOOTBALL BETTING DATA
|--------------------------------------------------------------------------
|
| IMPORTANT:
| We fetch odds by DATE instead of making
| one odds request for every fixture.
|
| This greatly reduces API-Football
| request usage.
|--------------------------------------------------------------------------
*/

app.get(
  "/api/football/betting",
  async (req, res) => {

    try {

      let days =
        Number(
          req.query.days
        );

      let limit =
        Number(
          req.query.limit
        );

      if (
        !Number.isFinite(days)
      ) {
        days = 3;
      }

      if (
        !Number.isFinite(limit)
      ) {
        limit = 10;
      }

      days =
        Math.max(
          1,
          Math.min(
            7,
            Math.floor(days)
          )
        );

      limit =
        Math.max(
          1,
          Math.min(
            30,
            Math.floor(limit)
          )
        );

      const matches = [];

      const diagnostics = {

        dates_checked: [],

        fixture_requests: 0,

        odds_requests: 0,

        fixtures_found: 0,

        odds_entries_found: 0,

        matches_with_odds: 0,

        errors: []

      };

      /*
      |--------------------------------------------------------------------------
      | Check dates one by one
      |--------------------------------------------------------------------------
      */

      for (
        let day = 0;
        day < days;
        day++
      ) {

        const date =
          getAddisDate(day);

        diagnostics
          .dates_checked
          .push(date);

        /*
        |--------------------------------------------------------------------------
        | Fixtures
        |--------------------------------------------------------------------------
        */

        const fixtureData =
          await fetchFootballFixtures(
            date
          );

        diagnostics.fixture_requests++;

        if (
          !fixtureData.success
        ) {

          diagnostics.errors.push({
            type:
              "fixtures",
            date,
            errors:
              fixtureData.errors
          });

          continue;
        }

        const fixtures =
          fixtureData.fixtures;

        diagnostics.fixtures_found +=
          fixtures.length;

        /*
        |--------------------------------------------------------------------------
        | Only upcoming fixtures
        |--------------------------------------------------------------------------
        */

        const upcomingFixtures =
          fixtures.filter(
            fixture => {

              const status =
                fixture.fixture
                  ?.status
                  ?.short;

              return [
                "NS",
                "TBD"
              ].includes(
                status
              );

            }
          );

        /*
        |--------------------------------------------------------------------------
        | Odds for the same date
        |--------------------------------------------------------------------------
        */

        const oddsData =
          await fetchFootballOddsByDate(
            date
          );

        diagnostics.odds_requests++;

        if (
          !oddsData.success
        ) {

          diagnostics.errors.push({
            type:
              "odds",
            date,
            errors:
              oddsData.errors
          });

          continue;
        }

        diagnostics.odds_entries_found +=
          oddsData.odds.length;

        /*
        |--------------------------------------------------------------------------
        | Map odds by fixture ID
        |--------------------------------------------------------------------------
        */

        const oddsByFixture =
          new Map();

        for (
          const oddsItem
          of oddsData.odds
        ) {

          const fixtureId =
            oddsItem?.fixture?.id;

          if (
            fixtureId === undefined ||
            fixtureId === null
          ) {

            continue;
          }

          oddsByFixture.set(
            String(fixtureId),
            oddsItem
          );

        }

        /*
        |--------------------------------------------------------------------------
        | Build betting matches
        |--------------------------------------------------------------------------
        */

        for (
          const fixture
          of upcomingFixtures
        ) {

          const fixtureId =
            fixture.fixture?.id;

          const oddsItem =
            oddsByFixture.get(
              String(fixtureId)
            );

          if (!oddsItem) {
            continue;
          }

          const markets =
            normalizeOdds(
              [oddsItem]
            );

          const hasOdds =
            Object.values(
              markets
            ).some(
              market =>
                market.length > 0
            );

          if (!hasOdds) {
            continue;
          }

          diagnostics.matches_with_odds++;

          let savedMatch = null;

          try {

            savedMatch =
              await saveMatchToDatabase(
                fixture
              );

          } catch (dbError) {

            console.error(
              "Match database save error:",
              dbError.message
            );

          }

          matches.push({

            id:
              savedMatch?.id ||
              null,

            external_id:
              String(
                fixtureId
              ),

            home_team:
              fixture.teams?.home?.name ||
              "Home",

            away_team:
              fixture.teams?.away?.name ||
              "Away",

            home_logo:
              fixture.teams?.home?.logo ||
              null,

            away_logo:
              fixture.teams?.away?.logo ||
              null,

            league:
              fixture.league?.name ||
              "Football",

            country:
              fixture.league?.country ||
              "",

            league_logo:
              fixture.league?.logo ||
              null,

            date:
              fixture.fixture?.date ||
              null,

            timezone:
              FOOTBALL_TIMEZONE,

            status:
              fixture.fixture
                ?.status
                ?.short ||
              "NS",

            markets,

            raw_fixture:
              fixture,

            raw_odds:
              oddsItem

          });

          if (
            matches.length >=
            limit
          ) {

            break;

          }

        }

        if (
          matches.length >=
          limit
        ) {

          break;

        }

      }

      res.json({

        success: true,

        count:
          matches.length,

        matches,

        diagnostics,

        message:
          matches.length > 0
            ? "Betting matches loaded successfully."
            : "No football matches with available betting data are currently available."

      });

    } catch (error) {

      console.error(
        "Football betting API error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not load football betting data.",

        error:
          error.message

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| LOCAL MATCHES
|--------------------------------------------------------------------------
*/

app.get(
  "/api/matches",
  async (req, res) => {

    try {

      const limit =
        Math.max(
          1,
          Math.min(
            100,
            Number(
              req.query.limit
            ) || 50
          )
        );

      const result =
        await pool.query(
          `
          SELECT *
          FROM matches
          WHERE status IN
            ('scheduled','live')
          ORDER BY
            started_at ASC NULLS LAST
          LIMIT $1
          `,
          [limit]
        );

      res.json({

        success: true,

        count:
          result.rows.length,

        matches:
          result.rows

      });

    } catch (error) {

      console.error(
        "Local matches error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not load matches."

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| SINGLE MATCH
|--------------------------------------------------------------------------
*/

app.get(
  "/api/matches/:id",
  async (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid match ID."

        });

      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM matches
          WHERE id = $1
          LIMIT 1
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
        "Single match error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not load match."

      });

    }

  }
);
/*
|--------------------------------------------------------------------------
| PLACE BET
|--------------------------------------------------------------------------
|
| IMPORTANT:
| Football bets must use server-side validated
| match/odds data in production.
|
|--------------------------------------------------------------------------
*/

app.post(
  "/api/bets/place",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const {
        user_id,
        match_id,
        external_id,
        game,
        selection,
        stake,
        odds
      } = req.body;

      /*
      |--------------------------------------------------------------------------
      | Basic validation
      |--------------------------------------------------------------------------
      */

      const userId =
        Number(user_id);

      const matchId =
        Number(match_id);

      const stakeAmount =
        Number(stake);

      const selectedOdds =
        Number(odds);

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid user."

        });

      }

      if (
        !Number.isInteger(matchId) ||
        matchId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid match."

        });

      }

      if (
        !Number.isFinite(stakeAmount) ||
        stakeAmount <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid stake."

        });

      }

      if (
        !Number.isFinite(selectedOdds) ||
        selectedOdds <= 1
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid odds."

        });

      }

      if (
        !selection ||
        typeof selection !== "string"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Selection is required."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Maximum safe values
      |--------------------------------------------------------------------------
      */

      if (
        stakeAmount > 100000
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Maximum stake exceeded."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Transaction
      |--------------------------------------------------------------------------
      */

      await client.query(
        "BEGIN"
      );

      /*
      |--------------------------------------------------------------------------
      | Lock user row
      |--------------------------------------------------------------------------
      */

      const userResult =
        await client.query(
          `
          SELECT
            id,
            balance,
            bonus_balance,
            is_active
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [userId]
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

      if (
        !user.is_active
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(403).json({

          success: false,

          message:
            "User account is inactive."

        });

      }

      const cashBalance =
        Number(
          user.balance
        ) || 0;

      const bonusBalance =
        Number(
          user.bonus_balance
        ) || 0;

      /*
      |--------------------------------------------------------------------------
      | Balance rules
      |--------------------------------------------------------------------------
      |
      | Real cash is used first.
      | Bonus can cover the remaining stake.
      |
      | Example:
      |
      | Cash = 20
      | Bonus = 50
      | Stake = 40
      |
      | Cash used = 20
      | Bonus used = 20
      |--------------------------------------------------------------------------
      */

      const cashUsed =
        Math.min(
          cashBalance,
          stakeAmount
        );

      const bonusUsed =
        stakeAmount -
        cashUsed;

      if (
        bonusUsed >
        bonusBalance
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
      |--------------------------------------------------------------------------
      | Match validation
      |--------------------------------------------------------------------------
      */

      const matchResult =
        await client.query(
          `
          SELECT *
          FROM matches
          WHERE id = $1
          LIMIT 1
          `,
          [matchId]
        );

      if (
        matchResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          success: false,

          message:
            "Match not found."

        });

      }

      const match =
        matchResult.rows[0];

      /*
      |--------------------------------------------------------------------------
      | Do not allow betting on finished,
      | cancelled or live matches here.
      |--------------------------------------------------------------------------
      */

      if (
        match.status !==
        "scheduled"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            "Betting is closed for this match."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | External ID validation
      |--------------------------------------------------------------------------
      */

      if (
        external_id &&
        String(
          external_id
        ) !==
        String(
          match.external_id
        )
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            "Match information is invalid."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | NOTE:
      |
      | Client supplied odds are NOT trusted for
      | production settlement.
      |
      | The next production step will store and
      | validate the exact server-side odds.
      |--------------------------------------------------------------------------
      */

      const potentialWin =
        Number(
          (
            stakeAmount *
            selectedOdds
          ).toFixed(2)
        );

      /*
      |--------------------------------------------------------------------------
      | Deduct wallet
      |--------------------------------------------------------------------------
      */

      const updatedUser =
        await client.query(
          `
          UPDATE users
          SET
            balance =
              balance - $1,
            bonus_balance =
              bonus_balance - $2,
            updated_at =
              NOW()
          WHERE id = $3
          RETURNING
            id,
            balance,
            bonus_balance
          `,
          [
            cashUsed,
            bonusUsed,
            userId
          ]
        );

      /*
      |--------------------------------------------------------------------------
      | Create bet
      |--------------------------------------------------------------------------
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
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7
          )
          RETURNING *
          `,
          [
            userId,
            game ||
              "football",
            stakeAmount,
            potentialWin,
            0,
            "pending",
            JSON.stringify({

              match_id:
                match.id,

              external_id:
                match.external_id,

              home_team:
                match.home_team,

              away_team:
                match.away_team,

              selection,

              odds:
                selectedOdds,

              cash_used:
                Number(
                  cashUsed.toFixed(2)
                ),

              bonus_used:
                Number(
                  bonusUsed.toFixed(2)
                )

            })
          ]
        );

      const bet =
        betResult.rows[0];

      /*
      |--------------------------------------------------------------------------
      | Transaction record
      |--------------------------------------------------------------------------
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
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )
        `,
        [
          userId,
          "bet",
          stakeAmount,
          "completed",
          `BET-${bet.id}`,
          `Football bet: ${selection}`
        ]
      );

      await client.query(
        "COMMIT"
      );

      /*
      |--------------------------------------------------------------------------
      | Socket update
      |--------------------------------------------------------------------------
      */

      io.emit(
        "balance:update",
        {
          user_id:
            userId,

          balance:
            Number(
              updatedUser.rows[0]
                .balance
            ),

          bonus_balance:
            Number(
              updatedUser.rows[0]
                .bonus_balance
            )
        }
      );

      res.json({

        success: true,

        message:
          "Bet placed successfully.",

        bet,

        wallet: {

          balance:
            Number(
              updatedUser.rows[0]
                .balance
            ),

          bonus_balance:
            Number(
              updatedUser.rows[0]
                .bonus_balance
            )

        }

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

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
| BET HISTORY
|--------------------------------------------------------------------------
*/

app.get(
  "/api/bets/history",
  async (req, res) => {

    try {

      const userId =
        Number(
          req.query.user_id
        );

      let limit =
        Number(
          req.query.limit
        );

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid user."

        });

      }

      if (
        !Number.isFinite(limit)
      ) {
        limit = 50;
      }

      limit =
        Math.max(
          1,
          Math.min(
            100,
            Math.floor(limit)
          )
        );

      const result =
        await pool.query(
          `
          SELECT
            id,
            user_id,
            game,
            stake,
            potential_win,
            actual_win,
            status,
            result,
            created_at,
            settled_at
          FROM bets
          WHERE user_id = $1
          ORDER BY
            created_at DESC
          LIMIT $2
          `,
          [
            userId,
            limit
          ]
        );

      res.json({

        success: true,

        count:
          result.rows.length,

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
| SINGLE BET
|--------------------------------------------------------------------------
*/

app.get(
  "/api/bets/:id",
  async (req, res) => {

    try {

      const betId =
        Number(
          req.params.id
        );

      const userId =
        Number(
          req.query.user_id
        );

      if (
        !Number.isInteger(
          betId
        ) ||
        betId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid bet ID."

        });

      }

      if (
        !Number.isInteger(
          userId
        ) ||
        userId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid user."

        });

      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM bets
          WHERE
            id = $1
            AND user_id = $2
          LIMIT 1
          `,
          [
            betId,
            userId
          ]
        );

      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "Bet not found."

        });

      }

      res.json({

        success: true,

        bet:
          result.rows[0]

      });

    } catch (error) {

      console.error(
        "Single bet error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not load bet."

      });

    }

  }
);
/*
|--------------------------------------------------------------------------
| DEPOSIT REQUEST
|--------------------------------------------------------------------------
*/

app.post(
  "/api/deposit/request",
  async (req, res) => {

    try {

      const {
        user_id,
        amount,
        method,
        reference
      } = req.body;

      const userId =
        Number(user_id);

      const depositAmount =
        Number(amount);

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {

        return res.status(400).json({
          success: false,
          message: "Invalid user."
        });

      }

      if (
        !Number.isFinite(depositAmount) ||
        depositAmount <= 0
      ) {

        return res.status(400).json({
          success: false,
          message: "Invalid deposit amount."
        });

      }

      /*
      |--------------------------------------------------------------------------
      | Minimum deposit
      |--------------------------------------------------------------------------
      */

      const settingResult =
        await pool.query(
          `
          SELECT value
          FROM settings
          WHERE key = 'minimum_deposit'
          LIMIT 1
          `
        );

      const minimumDeposit =
        Number(
          settingResult.rows[0]?.value
        ) || 51;

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

      /*
      |--------------------------------------------------------------------------
      | Verify user exists
      |--------------------------------------------------------------------------
      */

      const userResult =
        await pool.query(
          `
          SELECT
            id,
            is_active
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [userId]
        );

      if (
        userResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "User not found."

        });

      }

      if (
        !userResult.rows[0].is_active
      ) {

        return res.status(403).json({

          success: false,

          message:
            "User account is inactive."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Reference
      |--------------------------------------------------------------------------
      */

      const depositReference =
        reference &&
        String(reference).trim()
          ? String(reference).trim().slice(0, 100)
          : `DEP-${Date.now()}-${userId}`;

      /*
      |--------------------------------------------------------------------------
      | Create pending deposit
      |--------------------------------------------------------------------------
      */

      const result =
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
          (
            $1,
            'deposit',
            $2,
            'pending',
            $3,
            $4
          )
          RETURNING *
          `,
          [
            userId,
            depositAmount,
            depositReference,
            method
              ? `Deposit via ${String(method).slice(0, 50)}`
              : "Deposit request"
          ]
        );

      res.json({

        success: true,

        message:
          "Deposit request submitted successfully.",

        transaction:
          result.rows[0]

      });

    } catch (error) {

      console.error(
        "Deposit request error:",
        error.message
      );

      /*
      |--------------------------------------------------------------------------
      | Duplicate reference
      |--------------------------------------------------------------------------
      */

      if (
        error.code === "23505"
      ) {

        return res.status(409).json({

          success: false,

          message:
            "This deposit reference already exists."

        });

      }

      res.status(500).json({

        success: false,

        message:
          "Could not create deposit request."

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| WITHDRAW REQUEST
|--------------------------------------------------------------------------
|
| Withdrawal reserves the user's cash balance
| immediately.
|
| Bonus balance is NOT withdrawable directly.
|--------------------------------------------------------------------------
*/

app.post(
  "/api/withdraw/request",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const {
        user_id,
        amount,
        method,
        account
      } = req.body;

      const userId =
        Number(user_id);

      const withdrawAmount =
        Number(amount);

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid user."

        });

      }

      if (
        !Number.isFinite(withdrawAmount) ||
        withdrawAmount <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid withdrawal amount."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Minimum withdrawal
      |--------------------------------------------------------------------------
      */

      const settingResult =
        await client.query(
          `
          SELECT value
          FROM settings
          WHERE key = 'minimum_withdraw'
          LIMIT 1
          `
        );

      const minimumWithdraw =
        Number(
          settingResult.rows[0]?.value
        ) || 51;

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

      /*
      |--------------------------------------------------------------------------
      | Lock user
      |--------------------------------------------------------------------------
      */

      const userResult =
        await client.query(
          `
          SELECT
            id,
            balance,
            bonus_balance,
            is_active
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [userId]
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

      if (
        !user.is_active
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(403).json({

          success: false,

          message:
            "User account is inactive."

        });

      }

      const cashBalance =
        Number(
          user.balance
        ) || 0;

      /*
      |--------------------------------------------------------------------------
      | Bonus cannot be withdrawn
      |--------------------------------------------------------------------------
      */

      if (
        withdrawAmount >
        cashBalance
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

      /*
      |--------------------------------------------------------------------------
      | Prevent multiple pending withdrawals
      |--------------------------------------------------------------------------
      */

      const pendingResult =
        await client.query(
          `
          SELECT
            COALESCE(
              SUM(amount),
              0
            ) AS pending_amount
          FROM transactions
          WHERE
            user_id = $1
            AND type = 'withdraw'
            AND status = 'pending'
          `,
          [userId]
        );

      const pendingWithdraw =
        Number(
          pendingResult.rows[0]
            ?.pending_amount
        ) || 0;

      if (
        pendingWithdraw +
        withdrawAmount >
        cashBalance
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            "You already have a pending withdrawal."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Deduct / reserve cash
      |--------------------------------------------------------------------------
      */

      const updatedUser =
        await client.query(
          `
          UPDATE users
          SET
            balance =
              balance - $1,
            updated_at =
              NOW()
          WHERE id = $2
          RETURNING
            id,
            balance,
            bonus_balance
          `,
          [
            withdrawAmount,
            userId
          ]
        );

      /*
      |--------------------------------------------------------------------------
      | Create withdrawal transaction
      |--------------------------------------------------------------------------
      */

      const withdrawalReference =
        `WDR-${Date.now()}-${userId}`;

      const result =
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
          (
            $1,
            'withdraw',
            $2,
            'pending',
            $3,
            $4
          )
          RETURNING *
          `,
          [
            userId,
            withdrawAmount,
            withdrawalReference,
            [
              method
                ? `Method: ${String(method).slice(0, 50)}`
                : "Withdrawal",
              account
                ? `Account: ${String(account).slice(0, 100)}`
                : ""
            ]
              .filter(Boolean)
              .join(" | ")
          ]
        );

      await client.query(
        "COMMIT"
      );

      /*
      |--------------------------------------------------------------------------
      | Notify frontend
      |--------------------------------------------------------------------------
      */

      io.emit(
        "balance:update",
        {
          user_id:
            userId,

          balance:
            Number(
              updatedUser.rows[0]
                .balance
            ),

          bonus_balance:
            Number(
              updatedUser.rows[0]
                .bonus_balance
            )
        }
      );

      res.json({

        success: true,

        message:
          "Withdrawal request submitted successfully.",

        transaction:
          result.rows[0],

        wallet: {

          balance:
            Number(
              updatedUser.rows[0]
                .balance
            ),

          bonus_balance:
            Number(
              updatedUser.rows[0]
                .bonus_balance
            )

        }

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

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
| WALLET TRANSACTIONS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/wallet/transactions",
  async (req, res) => {

    try {

      const userId =
        Number(
          req.query.user_id
        );

      let limit =
        Number(
          req.query.limit
        );

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid user."

        });

      }

      if (
        !Number.isFinite(limit)
      ) {
        limit = 50;
      }

      limit =
        Math.max(
          1,
          Math.min(
            100,
            Math.floor(limit)
          )
        );

      const result =
        await pool.query(
          `
          SELECT
            id,
            user_id,
            type,
            amount,
            status,
            reference,
            description,
            created_at,
            updated_at
          FROM transactions
          WHERE user_id = $1
          ORDER BY
            created_at DESC
          LIMIT $2
          `,
          [
            userId,
            limit
          ]
        );

      res.json({

        success: true,

        count:
          result.rows.length,

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
| WALLET BALANCE
|--------------------------------------------------------------------------
*/

app.get(
  "/api/wallet/:userId",
  async (req, res) => {

    try {

      const userId =
        Number(
          req.params.userId
        );

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid user."

        });

      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            username,
            balance,
            bonus_balance,
            is_active,
            created_at
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [userId]
        );

      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "User not found."

        });

      }

      const user =
        result.rows[0];

      res.json({

        success: true,

        wallet: {

          user_id:
            user.id,

          balance:
            Number(
              user.balance
            ) || 0,

          bonus_balance:
            Number(
              user.bonus_balance
            ) || 0,

          total_display_balance:
            Number(
              user.balance
            ) +
            Number(
              user.bonus_balance
            )

        }

      });

    } catch (error) {

      console.error(
        "Wallet balance error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not load wallet."

      });

    }

  }
);
/*
|--------------------------------------------------------------------------
| ADMIN — PENDING TRANSACTIONS
|--------------------------------------------------------------------------
|
| TEMPORARY ADMIN API
|
| IMPORTANT:
| Real production admin authentication will be
| added before the platform goes live.
|--------------------------------------------------------------------------
*/

app.get(
  "/api/admin/transactions/pending",
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT
            t.*,
            u.name,
            u.username,
            u.telegram_id,
            u.phone
          FROM transactions t
          JOIN users u
            ON u.id = t.user_id
          WHERE t.status = 'pending'
          ORDER BY
            t.created_at ASC
          `
        );

      res.json({

        success: true,

        count:
          result.rows.length,

        transactions:
          result.rows

      });

    } catch (error) {

      console.error(
        "Pending transactions error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not load pending transactions."

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| ADMIN — APPROVE DEPOSIT
|--------------------------------------------------------------------------
*/

app.post(
  "/api/admin/deposit/approve",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const transactionId =
        Number(
          req.body.transaction_id
        );

      if (
        !Number.isInteger(
          transactionId
        ) ||
        transactionId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid transaction ID."

        });

      }

      await client.query(
        "BEGIN"
      );

      /*
      |--------------------------------------------------------------------------
      | Lock transaction
      |--------------------------------------------------------------------------
      */

      const transactionResult =
        await client.query(
          `
          SELECT *
          FROM transactions
          WHERE
            id = $1
            AND type = 'deposit'
          FOR UPDATE
          `,
          [transactionId]
        );

      if (
        transactionResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          success: false,

          message:
            "Deposit transaction not found."

        });

      }

      const transaction =
        transactionResult.rows[0];

      /*
      |--------------------------------------------------------------------------
      | Prevent double approval
      |--------------------------------------------------------------------------
      */

      if (
        transaction.status !==
        "pending"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            `Transaction is already ${transaction.status}.`

        });

      }

      const amount =
        Number(
          transaction.amount
        );

      /*
      |--------------------------------------------------------------------------
      | Credit user cash balance
      |--------------------------------------------------------------------------
      */

      const userResult =
        await client.query(
          `
          UPDATE users
          SET
            balance =
              balance + $1,
            updated_at =
              NOW()
          WHERE id = $2
          RETURNING
            id,
            balance,
            bonus_balance
          `,
          [
            amount,
            transaction.user_id
          ]
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

      /*
      |--------------------------------------------------------------------------
      | Mark deposit completed
      |--------------------------------------------------------------------------
      */

      const updatedTransaction =
        await client.query(
          `
          UPDATE transactions
          SET
            status = 'completed',
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [transactionId]
        );

      await client.query(
        "COMMIT"
      );

      const wallet =
        userResult.rows[0];

      /*
      |--------------------------------------------------------------------------
      | Notify frontend
      |--------------------------------------------------------------------------
      */

      io.emit(
        "balance:update",
        {
          user_id:
            wallet.id,

          balance:
            Number(
              wallet.balance
            ),

          bonus_balance:
            Number(
              wallet.bonus_balance
            )
        }
      );

      res.json({

        success: true,

        message:
          "Deposit approved successfully.",

        transaction:
          updatedTransaction.rows[0],

        wallet: {

          balance:
            Number(
              wallet.balance
            ),

          bonus_balance:
            Number(
              wallet.bonus_balance
            )

        }

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "Approve deposit error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not approve deposit."

      });

    } finally {

      client.release();

    }

  }
);

/*
|--------------------------------------------------------------------------
| ADMIN — APPROVE WITHDRAW
|--------------------------------------------------------------------------
*/

app.post(
  "/api/admin/withdraw/approve",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const transactionId =
        Number(
          req.body.transaction_id
        );

      if (
        !Number.isInteger(
          transactionId
        ) ||
        transactionId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid transaction ID."

        });

      }

      await client.query(
        "BEGIN"
      );

      /*
      |--------------------------------------------------------------------------
      | Lock transaction
      |--------------------------------------------------------------------------
      */

      const transactionResult =
        await client.query(
          `
          SELECT *
          FROM transactions
          WHERE
            id = $1
            AND type = 'withdraw'
          FOR UPDATE
          `,
          [transactionId]
        );

      if (
        transactionResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          success: false,

          message:
            "Withdrawal transaction not found."

        });

      }

      const transaction =
        transactionResult.rows[0];

      if (
        transaction.status !==
        "pending"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            `Transaction is already ${transaction.status}.`

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Withdrawal was already reserved
      |
      | Nothing is deducted here.
      |--------------------------------------------------------------------------
      */

      const updatedTransaction =
        await client.query(
          `
          UPDATE transactions
          SET
            status = 'completed',
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [transactionId]
        );

      await client.query(
        "COMMIT"
      );

      res.json({

        success: true,

        message:
          "Withdrawal approved successfully.",

        transaction:
          updatedTransaction.rows[0]

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "Approve withdrawal error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not approve withdrawal."

      });

    } finally {

      client.release();

    }

  }
);

/*
|--------------------------------------------------------------------------
| ADMIN — REJECT DEPOSIT
|--------------------------------------------------------------------------
*/

app.post(
  "/api/admin/deposit/reject",
  async (req, res) => {

    try {

      const transactionId =
        Number(
          req.body.transaction_id
        );

      if (
        !Number.isInteger(
          transactionId
        ) ||
        transactionId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid transaction ID."

        });

      }

      const result =
        await pool.query(
          `
          UPDATE transactions
          SET
            status = 'rejected',
            updated_at = NOW()
          WHERE
            id = $1
            AND type = 'deposit'
            AND status = 'pending'
          RETURNING *
          `,
          [transactionId]
        );

      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "Pending deposit not found."

        });

      }

      res.json({

        success: true,

        message:
          "Deposit rejected.",

        transaction:
          result.rows[0]

      });

    } catch (error) {

      console.error(
        "Reject deposit error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not reject deposit."

      });

    }

  }
);

/*
|--------------------------------------------------------------------------
| ADMIN — REJECT WITHDRAW + REFUND
|--------------------------------------------------------------------------
|
| Because withdrawal money was reserved from
| balance when requested, rejection returns
| the exact amount to the user's cash balance.
|--------------------------------------------------------------------------
*/

app.post(
  "/api/admin/withdraw/reject",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const transactionId =
        Number(
          req.body.transaction_id
        );

      if (
        !Number.isInteger(
          transactionId
        ) ||
        transactionId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid transaction ID."

        });

      }

      await client.query(
        "BEGIN"
      );

      /*
      |--------------------------------------------------------------------------
      | Lock withdrawal
      |--------------------------------------------------------------------------
      */

      const transactionResult =
        await client.query(
          `
          SELECT *
          FROM transactions
          WHERE
            id = $1
            AND type = 'withdraw'
          FOR UPDATE
          `,
          [transactionId]
        );

      if (
        transactionResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          success: false,

          message:
            "Withdrawal transaction not found."

        });

      }

      const transaction =
        transactionResult.rows[0];

      if (
        transaction.status !==
        "pending"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            `Transaction is already ${transaction.status}.`

        });

      }

      const amount =
        Number(
          transaction.amount
        );

      /*
      |--------------------------------------------------------------------------
      | Refund reserved cash
      |--------------------------------------------------------------------------
      */

      const userResult =
        await client.query(
          `
          UPDATE users
          SET
            balance =
              balance + $1,
            updated_at =
              NOW()
          WHERE id = $2
          RETURNING
            id,
            balance,
            bonus_balance
          `,
          [
            amount,
            transaction.user_id
          ]
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

      /*
      |--------------------------------------------------------------------------
      | Mark rejected
      |--------------------------------------------------------------------------
      */

      const updatedTransaction =
        await client.query(
          `
          UPDATE transactions
          SET
            status = 'rejected',
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [transactionId]
        );

      await client.query(
        "COMMIT"
      );

      const wallet =
        userResult.rows[0];

      /*
      |--------------------------------------------------------------------------
      | Notify frontend
      |--------------------------------------------------------------------------
      */

      io.emit(
        "balance:update",
        {
          user_id:
            wallet.id,

          balance:
            Number(
              wallet.balance
            ),

          bonus_balance:
            Number(
              wallet.bonus_balance
            )
        }
      );

      res.json({

        success: true,

        message:
          "Withdrawal rejected and funds refunded.",

        transaction:
          updatedTransaction.rows[0],

        wallet: {

          balance:
            Number(
              wallet.balance
            ),

          bonus_balance:
            Number(
              wallet.bonus_balance
            )

        }

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "Reject withdrawal error:",
        error.message
      );

      res.status(500).json({

        success: false,

        message:
          "Could not reject withdrawal."

      });

    } finally {

      client.release();


    }

  }
);
/*
|--------------------------------------------------------------------------
| SERVER-SIDE ODDS VALIDATION
|--------------------------------------------------------------------------
*/

/*
|--------------------------------------------------------------------------
| Find a specific selection inside normalized markets
|--------------------------------------------------------------------------
*/

function findSelectionInMarkets(
  markets,
  selection
) {

  if (
    !markets ||
    typeof markets !== "object"
  ) {

    return null;

  }

  const requested =
    String(
      selection || ""
    )
      .trim()
      .toLowerCase();

  if (!requested) {
    return null;
  }

  for (
    const [
      marketName,
      marketItems
    ]
    of Object.entries(markets)
  ) {

    if (
      !Array.isArray(
        marketItems
      )
    ) {

      continue;

    }

    for (
      const item
      of marketItems
    ) {

      const candidates = [

        item.name,

        item.value,

        item.label,

        item.selection,

        `${marketName}:${item.name}`,

        `${marketName}:${item.value}`

      ]
        .filter(
          value =>
            value !== undefined &&
            value !== null
        )
        .map(
          value =>
            String(value)
              .trim()
              .toLowerCase()
        );

      if (
        candidates.includes(
          requested
        )
      ) {

        return {

          market:
            marketName,

          selection:
            item.name ||
            item.value,

          odds:
            Number(
              item.odd
            ),

          item

        };

      }

    }

  }

  return null;

}

/*
|--------------------------------------------------------------------------
| Load current server-side odds
|--------------------------------------------------------------------------
*/

async function getServerOddsForMatch(
  externalId
) {

  if (
    !externalId
  ) {

    return null;

  }

  const result =
    await footballRequest(
      "odds",
      {
        fixture:
          externalId
      }
    );

  if (
    !result.ok
  ) {

    return null;

  }

  const response =
    Array.isArray(
      result.data?.response
    )
      ? result.data.response
      : [];

  if (
    response.length === 0
  ) {

    return null;

  }

  const markets =
    normalizeOdds(
      response
    );

  return {

    markets,

    raw:
      response

  };

}

/*
|--------------------------------------------------------------------------
| VALIDATE FOOTBALL BET
|--------------------------------------------------------------------------
*/

async function validateFootballBet(
  match,
  selection,
  clientOdds
) {

  if (
    !match
  ) {

    return {

      valid: false,

      message:
        "Match not found."

    };

  }

  /*
  |--------------------------------------------------------------------------
  | Match must still be scheduled
  |--------------------------------------------------------------------------
  */

  if (
    match.status !==
    "scheduled"
  ) {

    return {

      valid: false,

      message:
        "Betting is closed for this match."

    };

  }

  /*
  |--------------------------------------------------------------------------
  | Match must have external API ID
  |--------------------------------------------------------------------------
  */

  if (
    !match.external_id
  ) {

    return {

      valid: false,

      message:
        "Match data is incomplete."

    };

  }

  /*
  |--------------------------------------------------------------------------
  | Get current odds from server
  |--------------------------------------------------------------------------
  */

  const oddsData =
    await getServerOddsForMatch(
      match.external_id
    );

  if (
    !oddsData
  ) {

    return {

      valid: false,

      message:
        "Current odds are unavailable for this match."

    };

  }

  /*
  |--------------------------------------------------------------------------
  | Find requested selection
  |--------------------------------------------------------------------------
  */

  const found =
    findSelectionInMarkets(
      oddsData.markets,
      selection
    );

  if (
    !found
  ) {

    return {

      valid: false,

      message:
        "Selected betting option is no longer available."

    };

  }

  const currentOdds =
    Number(
      found.odds
    );

  const submittedOdds =
    Number(
      clientOdds
    );

  if (
    !Number.isFinite(
      currentOdds
    ) ||
    currentOdds <= 1
  ) {

    return {

      valid: false,

      message:
        "Current odds are invalid."

    };

  }

  /*
  |--------------------------------------------------------------------------
  | Compare client odds with server odds
  |--------------------------------------------------------------------------
  |
  | If odds changed, do NOT silently accept
  | the old price.
  |--------------------------------------------------------------------------
  */

  if (
    !Number.isFinite(
      submittedOdds
    )
  ) {

    return {

      valid: false,

      message:
        "Odds are required."

    };

  }

  const difference =
    Math.abs(
      currentOdds -
      submittedOdds
    );

  if (
    difference >
    0.0001
  ) {

    return {

      valid: false,

      odds_changed: true,

      old_odds:
        submittedOdds,

      current_odds:
        currentOdds,

      message:
        `Odds changed from ${submittedOdds.toFixed(2)} to ${currentOdds.toFixed(2)}. Please select again.`

    };

  }

  return {

    valid: true,

    market:
      found.market,

    selection:
      found.selection,

    odds:
      currentOdds,

    raw:
      oddsData.raw

  };

}

/*
|--------------------------------------------------------------------------
| REAL BET SETTLEMENT
|--------------------------------------------------------------------------
|
| This endpoint is intentionally admin-controlled.
|
| It settles ONLY from a supplied verified result.
| It does NOT randomly generate a winner.
|--------------------------------------------------------------------------
*/

app.post(
  "/api/admin/bets/settle",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const {
        bet_id,
        result,
        actual_win
      } = req.body;

      const betId =
        Number(
          bet_id
        );

      if (
        !Number.isInteger(
          betId
        ) ||
        betId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid bet ID."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Allowed settlement results
      |--------------------------------------------------------------------------
      */

      const settlementResult =
        String(
          result || ""
        )
          .trim()
          .toLowerCase();

      if (
        ![
          "won",
          "lost",
          "void"
        ].includes(
          settlementResult
        )
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Result must be won, lost, or void."

        });

      }

      await client.query(
        "BEGIN"
      );

      /*
      |--------------------------------------------------------------------------
      | Lock bet
      |--------------------------------------------------------------------------
      */

      const betResult =
        await client.query(
          `
          SELECT *
          FROM bets
          WHERE id = $1
          FOR UPDATE
          `,
          [betId]
        );

      if (
        betResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          success: false,

          message:
            "Bet not found."

        });

      }

      const bet =
        betResult.rows[0];

      /*
      |--------------------------------------------------------------------------
      | Prevent double settlement
      |--------------------------------------------------------------------------
      */

      if (
        bet.status !==
        "pending"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            `Bet is already ${bet.status}.`

        });

      }

      const stake =
        Number(
          bet.stake
        ) || 0;

      let winAmount = 0;

      /*
      |--------------------------------------------------------------------------
      | WON
      |--------------------------------------------------------------------------
      */

      if (
        settlementResult ===
        "won"
      ) {

        winAmount =
          Number(
            actual_win
          );

        /*
        |--------------------------------------------------------------------------
        | If actual_win wasn't supplied,
        | use potential_win saved with the bet.
        |--------------------------------------------------------------------------
        */

        if (
          !Number.isFinite(
            winAmount
          ) ||
          winAmount < 0
        ) {

          winAmount =
            Number(
              bet.potential_win
            ) || 0;

        }

      }

      /*
      |--------------------------------------------------------------------------
      | VOID
      |--------------------------------------------------------------------------
      |
      | Return the original stake.
      |--------------------------------------------------------------------------
      */

      if (
        settlementResult ===
        "void"
      ) {

        winAmount =
          stake;

      }

      /*
      |--------------------------------------------------------------------------
      | Credit winnings
      |--------------------------------------------------------------------------
      */

      if (
        winAmount > 0
      ) {

        await client.query(
          `
          UPDATE users
          SET
            balance =
              balance + $1,
            updated_at =
              NOW()
          WHERE id = $2
          `,
          [
            winAmount,
            bet.user_id
          ]
        );

      }

      /*
      |--------------------------------------------------------------------------
      | Update bet
      |--------------------------------------------------------------------------
      */

      const updatedBet =
        await client.query(
          `
          UPDATE bets
          SET
            actual_win = $1,
            status = $2,
            settled_at = NOW()
          WHERE id = $3
          RETURNING *
          `,
          [
            winAmount,
            settlementResult,
            betId
          ]
        );

      /*
      |--------------------------------------------------------------------------
      | Create settlement transaction
      |--------------------------------------------------------------------------
      */

      if (
        winAmount > 0
      ) {

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
          (
            $1,
            $2,
            $3,
            'completed',
            $4,
            $5
          )
          `,
          [
            bet.user_id,
            "win",
            winAmount,
            `WIN-${betId}`,
            settlementResult ===
              "void"
              ? `Void bet refund #${betId}`
              : `Bet winnings #${betId}`
          ]
        );

      }

      /*
      |--------------------------------------------------------------------------
      | Lost bets still get a settlement record
      |--------------------------------------------------------------------------
      */

      if (
        settlementResult ===
        "lost"
      ) {

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
          (
            $1,
            $2,
            $3,
            'completed',
            $4,
            $5
          )
          `,
          [
            bet.user_id,
            "loss",
            0,
            `LOSS-${betId}`,
            `Bet lost #${betId}`
          ]
        );

      }

      await client.query(
        "COMMIT"
      );

      /*
      |--------------------------------------------------------------------------
      | Get updated wallet
      |--------------------------------------------------------------------------
      */

      const walletResult =
        await pool.query(
          `
          SELECT
            id,
            balance,
            bonus_balance
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [bet.user_id]
        );

      const wallet =
        walletResult.rows[0];

      if (
        wallet
      ) {

        io.emit(
          "balance:update",
          {
            user_id:
              wallet.id,

            balance:
              Number(
                wallet.balance
              ),

            bonus_balance:
              Number(
                wallet.bonus_balance
              )
          }
        );

      }

      res.json({

        success: true,

        message:
          "Bet settled successfully.",

        bet:
          updatedBet.rows[0],

        wallet:
          wallet
            ? {
                balance:
                  Number(
                    wallet.balance
                  ),

                bonus_balance:
                  Number(
                    wallet.bonus_balance
                  )
              }
            : null

      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "Bet settlement error:",
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
| DISABLE OLD RANDOM TEST SETTLEMENT
|--------------------------------------------------------------------------
|
| IMPORTANT:
| Do not use random settlement for real betting.
|--------------------------------------------------------------------------
*/

app.post(
  "/api/test/settle-bet",
  async (req, res) => {

    return res.status(403).json({

      success: false,

      message:
        "Random test settlement is disabled. Use verified settlement."

    });

  }
);
/*
|--------------------------------------------------------------------------
| SOCKET.IO
|--------------------------------------------------------------------------
*/

io.on(
  "connection",
  socket => {

    console.log(
      "🔌 Client connected:",
      socket.id
    );

    /*
    |--------------------------------------------------------------------------
    | Join user room
    |--------------------------------------------------------------------------
    */

    socket.on(
      "join:user",
      userId => {

        const id =
          Number(userId);

        if (
          Number.isInteger(id) &&
          id > 0
        ) {

          socket.join(
            `user:${id}`
          );

          console.log(
            `👤 User ${id} joined socket room.`
          );

        }

      }
    );

    /*
    |--------------------------------------------------------------------------
    | Leave user room
    |--------------------------------------------------------------------------
    */

    socket.on(
      "leave:user",
      userId => {

        const id =
          Number(userId);

        if (
          Number.isInteger(id) &&
          id > 0
        ) {

          socket.leave(
            `user:${id}`
          );

        }

      }
    );

    /*
    |--------------------------------------------------------------------------
    | Disconnect
    |--------------------------------------------------------------------------
    */

    socket.on(
      "disconnect",
      reason => {

        console.log(
          "🔌 Client disconnected:",
          socket.id,
          reason
        );

      }
    );

  }
);

/*
|--------------------------------------------------------------------------
| 404 HANDLER
|--------------------------------------------------------------------------
*/

app.use(
  (req, res) => {

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {

      return res.status(404).json({

        success: false,

        message:
          "API endpoint not found."

      });

    }

    res.status(404).send(
      "Page not found."
    );

  }
);

/*
|--------------------------------------------------------------------------
| GLOBAL ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "Unhandled server error:",
      error
    );

    if (
      res.headersSent
    ) {

      return next(
        error
      );

    }

    res.status(500).json({

      success: false,

      message:
        "Internal server error."

    });

  }
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

async function startServer() {

  try {

    /*
    |--------------------------------------------------------------------------
    | Database initialization
    |--------------------------------------------------------------------------
    */

    await initializeDatabase();

    /*
    |--------------------------------------------------------------------------
    | Start HTTP server
    |--------------------------------------------------------------------------
    */

    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "=================================================="
        );

        console.log(
          "🎯 Ethiopia Betting"
        );

        console.log(
          "=================================================="
        );

        console.log(
          `🚀 Server running on port ${PORT}`
        );

        console.log(
          `🌐 Environment: ${
            process.env.NODE_ENV ||
            "development"
          }`
        );

        console.log(
          "⚽ API-Football:",
          API_FOOTBALL_KEY
            ? "configured"
            : "NOT configured"
        );

        console.log(
          "🗄️ PostgreSQL: configured"
        );

        console.log(
          "🔌 Socket.IO: enabled"
        );

        console.log(
          "=================================================="
        );

      }
    );

  } catch (error) {

    console.error(
      "❌ Server startup failed:",
      error.message
    );

    process.exit(
      1
    );

  }

}

/*
|--------------------------------------------------------------------------
| PROCESS ERROR HANDLERS
|--------------------------------------------------------------------------
*/

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "❌ Unhandled Promise Rejection:",
      error
    );

  }
);

process.on(
  "uncaughtException",
  error => {

    console.error(
      "❌ Uncaught Exception:",
      error
    );

    /*
    |--------------------------------------------------------------------------
    | Give the process a chance to exit cleanly.
    |--------------------------------------------------------------------------
    */

    setTimeout(
      () => {
        process.exit(1);
      },
      1000
    );

  }
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

startServer();
