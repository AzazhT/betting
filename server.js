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
| The Odds API
|--------------------------------------------------------------------------
*/

const ODDS_API_KEY =
  process.env.ODDS_API_KEY;

const ODDS_API_URL =
  "https://api.the-odds-api.com/v4";

const FOOTBALL_TIMEZONE =
  "Africa/Addis_Ababa";

const ODDS_API_REGION =
  process.env.ODDS_API_REGION ||
  "eu";

const ODDS_API_MARKETS =
  process.env.ODDS_API_MARKETS ||
  "h2h,spreads,totals";

const ODDS_API_BOOKMAKER_KEY =
  process.env.ODDS_API_BOOKMAKER_KEY ||
  "";

const ODDS_API_SPORTS =
  (
    process.env.ODDS_API_SPORTS ||
    [
      "soccer_epl",
      "soccer_uefa_champs_league",
      "soccer_italy_serie_a",
      "soccer_spain_la_liga",
      "soccer_germany_bundesliga",
      "soccer_france_ligue_one"
    ].join(",")
  )
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

const ODDS_CACHE_TTL_MS =
  60 * 1000;

const ODDS_API_ADDITIONAL_MARKETS =
  process.env.ODDS_API_ADDITIONAL_MARKETS ||
  "btts,double_chance,draw_no_bet";

const oddsCache =
  new Map();

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
| THE ODDS API REQUEST HELPER
|--------------------------------------------------------------------------
*/

async function oddsApiRequest(
  endpoint,
  params = {},
  options = {}
) {

  if (!ODDS_API_KEY) {

    throw new Error(
      "ODDS_API_KEY is not configured."
    );

  }

  const query =
    new URLSearchParams();

  query.set(
    "apiKey",
    ODDS_API_KEY
  );

  for (
    const [key, value]
    of Object.entries(params)
  ) {

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {

      query.set(
        key,
        String(value)
      );

    }

  }

  const url =
    `${ODDS_API_URL}${endpoint}?${query.toString()}`;

  console.log(
    "⚽ The Odds API request:",
    endpoint,
    params
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            "application/json"
        },
        signal:
          options.signal
      }
    );

  let data = null;

  try {

    data =
      await response.json();

  } catch (error) {

    data = {
      error:
        "API returned invalid JSON."
    };

  }

  return {
    http_status:
      response.status,

    ok:
      response.ok,

    data,

    headers: {
      remaining:
        response.headers.get(
          "x-requests-remaining"
        ),
      used:
        response.headers.get(
          "x-requests-used"
        ),
      last:
        response.headers.get(
          "x-requests-last"
        )
    }
  };
}

/*
|--------------------------------------------------------------------------
| ODDS API CACHE
|--------------------------------------------------------------------------
*/

function getOddsCacheKey(
  sportKey,
  regions,
  markets
) {

  return [
    sportKey,
    regions,
    markets
  ].join("|");
}

async function fetchOddsForSport(
  sportKey,
  options = {}
) {

  const regions =
    options.regions ||
    ODDS_API_REGION;

  const markets =
    options.markets ||
    ODDS_API_MARKETS;

  const cacheKey =
    getOddsCacheKey(
      sportKey,
      regions,
      markets
    );

  const cached =
    oddsCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.timestamp <
      ODDS_CACHE_TTL_MS
  ) {

    return cached.value;

  }

  const result =
    await oddsApiRequest(
      `/sports/${encodeURIComponent(
        sportKey
      )}/odds/`,
      {
        regions,
        markets,
        oddsFormat: "decimal",
        dateFormat: "iso"
      }
    );

  const value = {
    ...result,
    events:
      Array.isArray(result.data)
        ? result.data
        : []
  };

  oddsCache.set(
    cacheKey,
    {
      timestamp:
        Date.now(),
      value
    }
  );

  return value;
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

      const result =
        await oddsApiRequest(
          "/sports/",
          {
            all: "false"
          }
        );

      const sports =
        Array.isArray(result.data)
          ? result.data
          : [];

      res.json({

        success:
          result.ok,

        http_status:
          result.http_status,

        provider:
          "The Odds API",

        configured_sports:
          ODDS_API_SPORTS,

        football_sports:
          sports.filter(
            sport =>
              String(
                sport?.key || ""
              ).startsWith(
                "soccer_"
              )
          ),

        errors:
          result.ok
            ? {}
            : result.data
      });

    } catch (error) {

      console.error(
        "The Odds API diagnostic error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          error.message
      });

    }
  }
);

/*
|--------------------------------------------------------------------------
| FOOTBALL API TEST
|--------------------------------------------------------------------------
*/

app.get(
  "/api/football/test",
  async (req, res) => {

    try {

      const sport =
        String(
          req.query.sport ||
          ODDS_API_SPORTS[0] ||
          "soccer_epl"
        );

      const result =
        await fetchOddsForSport(
          sport,
          {
            regions:
              req.query.regions ||
              ODDS_API_REGION,
            markets:
              req.query.markets ||
              ODDS_API_MARKETS
          }
        );

      res.json({

        success:
          result.ok,

        provider:
          "The Odds API",

        sport,

        region:
          req.query.regions ||
          ODDS_API_REGION,

        markets:
          req.query.markets ||
          ODDS_API_MARKETS,

        http_status:
          result.http_status,

        quota:
          result.headers,

        errors:
          result.ok
            ? {}
            : result.data,

        count:
          result.events.length,

        events:
          result.events
      });

    } catch (error) {

      console.error(
        "The Odds API test error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          error.message
      });

    }
  }
);

/*
|--------------------------------------------------------------------------
| EVENT ODDS TEST
|--------------------------------------------------------------------------
*/

app.get(
  "/api/football/odds/:fixtureId",
  async (req, res) => {

    try {

      const externalId =
        String(
          req.params.fixtureId ||
          ""
        ).trim();

      const parsed =
        parseOddsExternalId(
          externalId
        );

      if (!parsed) {

        return res.status(400).json({
          success: false,
          message:
            "Invalid event ID."
        });

      }

      const result =
        await oddsApiRequest(
          `/sports/${encodeURIComponent(
            parsed.sportKey
          )}/events/${encodeURIComponent(
            parsed.eventId
          )}/odds/`,
          {
            regions:
              req.query.regions ||
              ODDS_API_REGION,
            markets:
              req.query.markets ||
              ODDS_API_MARKETS,
            oddsFormat:
              "decimal",
            dateFormat:
              "iso"
          }
        );

      res.json({

        success:
          result.ok,

        provider:
          "The Odds API",

        sport:
          parsed.sportKey,

        event_id:
          parsed.eventId,

        http_status:
          result.http_status,

        quota:
          result.headers,

        errors:
          result.ok
            ? {}
            : result.data,

        response:
          result.ok
            ? result.data
            : null
      });

    } catch (error) {

      console.error(
        "Event odds error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          error.message
      });

    }
  }
);

/*
|--------------------------------------------------------------------------
| ODDS API SPORTS MARKET NORMALIZER
|--------------------------------------------------------------------------
|
| Keeps the existing frontend market shape:
| 1x2, double, overunder, btts, handicap.
|
| The featured /odds endpoint supplies h2h,
| spreads and totals. Additional soccer markets
| such as btts and double_chance can be added later
| through the event-odds endpoint.
|--------------------------------------------------------------------------
*/

function chooseOddsBookmaker(
  event
) {

  const bookmakers =
    Array.isArray(
      event?.bookmakers
    )
      ? event.bookmakers
      : [];

  if (
    bookmakers.length === 0
  ) {
    return null;
  }

  if (
    ODDS_API_BOOKMAKER_KEY
  ) {

    const preferred =
      bookmakers.find(
        bookmaker =>
          bookmaker?.key ===
          ODDS_API_BOOKMAKER_KEY
      );

    if (preferred) {
      return preferred;
    }

  }

  return [...bookmakers]
    .sort(
      (a, b) =>
        String(a?.key || "")
          .localeCompare(
            String(b?.key || "")
          )
    )[0];
}

function normalizeOdds(
  oddsResponse
) {

  const markets = {
    "1x2": [],
    double: [],
    overunder: [],
    btts: [],
    handicap: [],
    draw_no_bet: [],
    correct_score: [],
    halftime_fulltime: []
  };

  const events =
    Array.isArray(oddsResponse)
      ? oddsResponse
      : oddsResponse
        ? [oddsResponse]
        : [];

  for (
    const event
    of events
  ) {

    const bookmaker =
      chooseOddsBookmaker(
        event
      );

    if (!bookmaker) {
      continue;
    }

    const bookmakerKey =
      bookmaker.key ||
      "";

    const bookmakerTitle =
      bookmaker.title ||
      bookmakerKey ||
      "Bookmaker";

    const eventMarkets =
      Array.isArray(
        bookmaker.markets
      )
        ? bookmaker.markets
        : [];

    for (
      const market
      of eventMarkets
    ) {

      const marketKey =
        String(
          market?.key ||
          ""
        )
          .trim()
          .toLowerCase();

      const outcomes =
        Array.isArray(
          market?.outcomes
        )
          ? market.outcomes
          : [];

      for (
        const outcome
        of outcomes
      ) {

        const odd =
          Number(
            outcome?.price
          );

        if (
          !Number.isFinite(odd) ||
          odd <= 1
        ) {
          continue;
        }

        const rawName =
          String(
            outcome?.name ||
            ""
          );

        const point =
          outcome?.point ??
          null;

        let displayName =
          rawName;

        if (
          (marketKey === "totals" ||
            marketKey === "spreads") &&
          point !== null &&
          point !== undefined &&
          point !== ""
        ) {

          displayName =
            `${rawName} ${Number(point) > 0 ? "+" : ""}${point}`;

        }

        const base = {
          name:
            displayName,
          value:
            displayName,
          odd,
          bookmaker_key:
            bookmakerKey,
          bookmaker_title:
            bookmakerTitle,
          point
        };

        if (
          marketKey ===
          "h2h"
        ) {

          markets["1x2"].push(
            base
          );

        } else if (
          marketKey ===
          "spreads"
        ) {

          markets.handicap.push({
            ...base,
            line:
              outcome?.point ??
              null
          });

        } else if (
          marketKey ===
          "totals"
        ) {

          markets.overunder.push({
            ...base,
            line:
              outcome?.point ??
              null
          });

        } else if (
          marketKey ===
          "btts"
        ) {

          markets.btts.push(
            base
          );

        } else if (
          marketKey ===
          "double_chance"
        ) {

          markets.double.push(
            base
          );

        } else if (
          marketKey ===
          "draw_no_bet"
        ) {

          markets.draw_no_bet.push(
            base
          );

        } else if (
          marketKey ===
          "correct_score"
        ) {

          markets.correct_score.push(
            base
          );

        } else if (
          marketKey ===
          "halftime_fulltime"
        ) {

          markets.halftime_fulltime.push(
            base
          );

        }

      }

    }

  }

  for (
    const key
    of Object.keys(markets)
  ) {

    const seen =
      new Set();

    markets[key] =
      markets[key].filter(
        item => {

          const identifier =
            JSON.stringify([
              item.name,
              item.point ??
                item.line ??
                null,
              item.odd,
              item.bookmaker_key
            ]);

          if (
            seen.has(identifier)
          ) {
            return false;
          }

          seen.add(identifier);
          return true;
        }
      );
  }

  return markets;
}

/*
|--------------------------------------------------------------------------
| PARSE THE ODDS API EXTERNAL MATCH ID
|--------------------------------------------------------------------------
|
| Format stored in matches.external_id:
|   sportKey:eventId
|--------------------------------------------------------------------------
*/

function buildOddsExternalId(
  sportKey,
  eventId
) {

  return `${sportKey}:${eventId}`;
}

function parseOddsExternalId(
  externalId
) {

  const value =
    String(
      externalId ||
      ""
    ).trim();

  const separator =
    value.indexOf(":");

  if (
    separator <= 0 ||
    separator >=
      value.length - 1
  ) {
    return null;
  }

  return {
    sportKey:
      value.slice(
        0,
        separator
      ),
    eventId:
      value.slice(
        separator + 1
      )
  };
}

/*
|--------------------------------------------------------------------------
| SAVE / UPDATE MATCH FROM THE ODDS API
|--------------------------------------------------------------------------
*/

async function saveOddsEventToDatabase(
  event
) {

  if (
    !event?.id ||
    !event?.sport_key
  ) {
    return null;
  }

  const externalId =
    buildOddsExternalId(
      event.sport_key,
      event.id
    );

  const homeTeam =
    event.home_team ||
    "Home";

  const awayTeam =
    event.away_team ||
    "Away";

  const startedAt =
    event.commence_time
      ? new Date(
          event.commence_time
        )
      : null;

  const validStartedAt =
    startedAt &&
    !Number.isNaN(
      startedAt.getTime()
    )
      ? startedAt
      : null;

  const matchStatus =
    validStartedAt &&
    validStartedAt.getTime() <=
      Date.now()
      ? "live"
      : "scheduled";

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
      started_at = EXCLUDED.started_at,
      updated_at = NOW()
    RETURNING *
  `;

  const dbResult =
    await pool.query(
      query,
      [
        externalId,
        homeTeam,
        awayTeam,
        matchStatus,
        null,
        null,
        null,
        validStartedAt,
        null
      ]
    );

  return dbResult.rows[0];
}

/*
|--------------------------------------------------------------------------
| ADDITIONAL SOCCER MARKETS
|--------------------------------------------------------------------------
*/
async function fetchAdditionalSoccerMarkets(sportKey, eventId) {
  const markets = ODDS_API_ADDITIONAL_MARKETS;
  if (!markets) return { ok: true, data: null, headers: {} };
  const cacheKey = `event|${sportKey}|${eventId}|${markets}`;
  const cached = oddsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ODDS_CACHE_TTL_MS) return cached.value;
  const result = await oddsApiRequest(
    `/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(eventId)}/odds/`,
    { regions: ODDS_API_REGION, markets, oddsFormat: "decimal", dateFormat: "iso" }
  );
  oddsCache.set(cacheKey, { timestamp: Date.now(), value: result });
  return result;
}

function mergeBookmakerMarkets(baseEvent, additionalEvent) {
  const merged = { ...(baseEvent || {}) };
  const map = new Map();
  for (const b of Array.isArray(baseEvent?.bookmakers) ? baseEvent.bookmakers : []) {
    if (b?.key) map.set(String(b.key), { ...b, markets: Array.isArray(b.markets) ? [...b.markets] : [] });
  }
  for (const b of Array.isArray(additionalEvent?.bookmakers) ? additionalEvent.bookmakers : []) {
    if (!b?.key) continue;
    const k = String(b.key);
    if (!map.has(k)) { map.set(k, { ...b, markets: Array.isArray(b.markets) ? [...b.markets] : [] }); continue; }
    const cur = map.get(k);
    const idx = new Map((cur.markets || []).map((m,i)=>[String(m?.key || ""),i]));
    for (const m of Array.isArray(b.markets) ? b.markets : []) {
      const mk = String(m?.key || "");
      if (idx.has(mk)) cur.markets[idx.get(mk)] = m; else { idx.set(mk, cur.markets.length); cur.markets.push(m); }
    }
    map.set(k, cur);
  }
  merged.bookmakers = Array.from(map.values());
  return merged;
}

/*
|--------------------------------------------------------------------------
| FOOTBALL BETTING DATA — THE ODDS API
|--------------------------------------------------------------------------
*/

app.get(
  "/api/football/betting",
  async (req, res) => {

    try {

      let limit =
        Number(
          req.query.limit
        );

      if (
        !Number.isFinite(limit)
      ) {
        limit = 10;
      }

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
        provider:
          "The Odds API",
        sports_checked: [],
        odds_requests: 0,
        events_found: 0,
        matches_with_odds: 0,
        additional_market_requests: 0,
        errors: [],
        quota: []
      };

      for (
        const sportKey
        of ODDS_API_SPORTS
      ) {

        diagnostics.sports_checked.push(
          sportKey
        );

        const oddsData =
          await fetchOddsForSport(
            sportKey
          );

        diagnostics.odds_requests++;

        diagnostics.quota.push({
          sport:
            sportKey,
          ...oddsData.headers
        });

        if (
          !oddsData.ok
        ) {

          diagnostics.errors.push({
            sport:
              sportKey,
            http_status:
              oddsData.http_status,
            error:
              oddsData.data
          });

          continue;
        }

        diagnostics.events_found +=
          oddsData.events.length;

        for (
          const event
          of oddsData.events
        ) {

          let enrichedEvent = event;

          try {
            const additional = await fetchAdditionalSoccerMarkets(event.sport_key, event.id);
            diagnostics.additional_market_requests++;
            if (additional.ok && additional.data) {
              enrichedEvent = mergeBookmakerMarkets(event, additional.data);
            }
          } catch (additionalError) {
            diagnostics.errors.push({ type: "additional_markets", sport: event.sport_key, event_id: event.id, error: additionalError.message });
          }

          const markets =
            normalizeOdds(
              enrichedEvent
            );

          const hasOdds =
            Object.values(
              markets
            ).some(
              market =>
                Array.isArray(
                  market
                ) &&
                market.length > 0
            );

          if (!hasOdds) {
            continue;
          }

          const startedAt =
            event.commence_time
              ? new Date(
                  event.commence_time
                )
              : null;

          if (
            !startedAt ||
            Number.isNaN(
              startedAt.getTime()
            ) ||
            startedAt.getTime() <=
              Date.now()
          ) {
            continue;
          }

          diagnostics.matches_with_odds++;

          let savedMatch =
            null;

          try {

            savedMatch =
              await saveOddsEventToDatabase(
                event
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
              buildOddsExternalId(
                event.sport_key,
                event.id
              ),

            event_id:
              event.id,

            sport_key:
              event.sport_key,

            home_team:
              event.home_team ||
              "Home",

            away_team:
              event.away_team ||
              "Away",

            league:
              event.sport_title ||
              sportKey,

            country:
              "",

            date:
              event.commence_time ||
              null,

            timezone:
              FOOTBALL_TIMEZONE,

            status:
              "NS",

            markets,

            raw_event:
              enrichedEvent

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

        success:
          diagnostics.errors.length === 0,

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
          error.message
      });

    }
  }
);


/*
|--------------------------------------------------------------------------
| PLACE ACCUMULATOR BET
|--------------------------------------------------------------------------
*/

app.post(
  "/api/bets/place-accumulator",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const userId =
        Number(
          req.body.user_id
        );

      const stakeAmount =
        Number(
          req.body.stake
        );

      const requestedBets =
        Array.isArray(
          req.body.bets
        )
          ? req.body.bets
          : [];

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
        stakeAmount > 100000
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Maximum stake exceeded."
        });
      }

      if (
        requestedBets.length < 2
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Select at least two outcomes for an accumulator."
        });
      }

      if (
        requestedBets.length > 10
      ) {
        return res.status(400).json({
          success: false,
          message:
            "A maximum of 10 selections is allowed."
        });
      }

      const uniqueMatchIds =
        new Set();

      for (
        const item of requestedBets
      ) {
        const matchId =
          Number(item?.match_id);

        if (
          !Number.isInteger(matchId) ||
          matchId <= 0
        ) {
          return res.status(400).json({
            success: false,
            message:
              "One or more match IDs are invalid."
          });
        }

        if (
          uniqueMatchIds.has(matchId)
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Only one selection per match is allowed."
          });
        }

        uniqueMatchIds.add(matchId);
      }

      /*
      |--------------------------------------------------------------------------
      | Validate every selection against current server-side odds.
      |--------------------------------------------------------------------------
      */

      const validatedLegs = [];

      for (
        const item of requestedBets
      ) {

        const matchId =
          Number(item.match_id);

        const clientOdds =
          Number(item.odds);

        const selection =
          String(
            item.selection ||
            ""
          ).trim();

        if (
          !Number.isFinite(clientOdds) ||
          clientOdds <= 1 ||
          !selection
        ) {
          return res.status(400).json({
            success: false,
            message:
              "One or more betting selections are invalid."
          });
        }

        const matchResult =
          await pool.query(
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
          return res.status(404).json({
            success: false,
            message:
              `Match ${matchId} was not found.`
          });
        }

        const match =
          matchResult.rows[0];

        if (
          item.external_id &&
          String(item.external_id) !==
          String(match.external_id)
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Match information is invalid."
          });
        }

        const validation =
          await validateFootballBet(
            match,
            selection,
            clientOdds
          );

        if (
          !validation.valid
        ) {
          return res.status(409).json({
            success: false,
            message:
              validation.message,
            odds_changed:
              validation.odds_changed || false,
            old_odds:
              validation.old_odds ?? null,
            current_odds:
              validation.current_odds ?? null,
            failed_match_id:
              match.id
          });
        }

        validatedLegs.push({
          match_id:
            match.id,
          external_id:
            match.external_id,
          home_team:
            match.home_team,
          away_team:
            match.away_team,
          selection:
            validation.selection,
          odds:
            Number(validation.odds),
          market:
            validation.market,
          bookmaker_key:
            validation.bookmaker_key,
          bookmaker_title:
            validation.bookmaker_title
        });
      }

      const combinedOdds =
        validatedLegs.reduce(
          (total, leg) =>
            total * Number(leg.odds),
          1
        );

      const potentialWin =
        Number(
          (
            stakeAmount *
            combinedOdds
          ).toFixed(2)
        );

      await client.query(
        "BEGIN"
      );

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

      const cashBalance =
        Number(user.balance) || 0;

      const bonusBalance =
        Number(user.bonus_balance) || 0;

      const cashUsed =
        Math.min(
          cashBalance,
          stakeAmount
        );

      const bonusUsed =
        stakeAmount -
        cashUsed;

      if (
        bonusUsed > bonusBalance
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

      const updatedUser =
        await client.query(
          `
          UPDATE users
          SET
            balance = balance - $1,
            bonus_balance = bonus_balance - $2,
            updated_at = NOW()
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
            "football_accumulator",
            stakeAmount,
            potentialWin,
            0,
            "pending",
            JSON.stringify({
              type:
                "accumulator",
              combined_odds:
                Number(
                  combinedOdds.toFixed(4)
                ),
              legs:
                validatedLegs,
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
          `Football accumulator (${validatedLegs.length} selections)`
        ]
      );

      await client.query(
        "COMMIT"
      );

      io.emit(
        "balance:update",
        {
          user_id:
            userId,
          balance:
            Number(
              updatedUser.rows[0].balance
            ),
          bonus_balance:
            Number(
              updatedUser.rows[0].bonus_balance
            )
        }
      );

      res.json({
        success: true,
        message:
          "Accumulator bet placed successfully.",
        bet,
        selections:
          validatedLegs.length,
        combined_odds:
          Number(
            combinedOdds.toFixed(4)
          ),
        potential_win:
          potentialWin,
        wallet: {
          balance:
            Number(
              updatedUser.rows[0].balance
            ),
          bonus_balance:
            Number(
              updatedUser.rows[0].bonus_balance
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
        "Accumulator bet error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message:
          "Could not place accumulator bet."
      });

    } finally {
      client.release();
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

      const clientOdds =
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
        !Number.isFinite(clientOdds) ||
        clientOdds <= 1
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

      if (
        game &&
        game !== "football"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Unsupported game."

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
      | Load match before wallet transaction
      |--------------------------------------------------------------------------
      */

      const matchLookup =
        await pool.query(
          `
          SELECT *
          FROM matches
          WHERE id = $1
          LIMIT 1
          `,
          [matchId]
        );

      if (
        matchLookup.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "Match not found."

        });

      }

      const matchForValidation =
        matchLookup.rows[0];

      if (
        external_id &&
        String(external_id) !==
        String(matchForValidation.external_id)
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Match information is invalid."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Server-side odds validation
      |--------------------------------------------------------------------------
      |
      | The frontend supplied odds are never trusted for settlement.
      | We load the current odds from The Odds API and require the
      | requested selection and price to still match.
      |--------------------------------------------------------------------------
      */

      const validation =
        await validateFootballBet(
          matchForValidation,
          selection,
          clientOdds
        );

      if (!validation.valid) {

        return res.status(409).json({

          success: false,

          message:
            validation.message,

          odds_changed:
            validation.odds_changed || false,

          old_odds:
            validation.old_odds ?? null,

          current_odds:
            validation.current_odds ?? null

        });

      }

      const serverOdds =
        Number(validation.odds);

      const canonicalSelection =
        validation.selection;

      const market =
        validation.market;

      if (
        !Number.isFinite(serverOdds) ||
        serverOdds <= 1
      ) {

        return res.status(409).json({

          success: false,

          message:
            "Current odds are invalid. Please select again."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Wallet transaction
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
      | Re-load and lock match row before final wallet/bet commit
      |--------------------------------------------------------------------------
      */

      const lockedMatchResult =
        await client.query(
          `
          SELECT *
          FROM matches
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
          `,
          [matchId]
        );

      if (
        lockedMatchResult.rows.length === 0
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

      const lockedMatch =
        lockedMatchResult.rows[0];

      if (
        lockedMatch.status !==
        "scheduled"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({

          success: false,

          message:
            "Betting is closed for this match."

        });

      }

      if (
        lockedMatch.external_id &&
        String(lockedMatch.external_id) !==
        String(matchForValidation.external_id)
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({

          success: false,

          message:
            "Match information changed. Please select again."

        });

      }

      /*
      |--------------------------------------------------------------------------
      | Potential win uses server-side odds
      |--------------------------------------------------------------------------
      */

      const potentialWin =
        Number(
          (
            stakeAmount *
            serverOdds
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

      if (
        updatedUser.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(500).json({

          success: false,

          message:
            "Could not update wallet."

        });

      }

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
                lockedMatch.id,

              external_id:
                lockedMatch.external_id,

              home_team:
                lockedMatch.home_team,

              away_team:
                lockedMatch.away_team,

              market,

              selection:
                canonicalSelection,

              client_selection:
                selection,

              odds:
                serverOdds,

              bookmaker_key:
                validation.bookmaker_key ||
                null,

              bookmaker_title:
                validation.bookmaker_title ||
                null,

              client_odds:
                clientOdds,

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
          `Football bet: ${canonicalSelection}`
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
| LOAD CURRENT SERVER-SIDE ODDS
|--------------------------------------------------------------------------
*/

async function getServerOddsForMatch(
  externalId
) {
  const parsed = parseOddsExternalId(externalId);
  if (!parsed) return null;

  const featuredResult = await oddsApiRequest(
    `/sports/${encodeURIComponent(parsed.sportKey)}/events/${encodeURIComponent(parsed.eventId)}/odds/`,
    { regions: ODDS_API_REGION, markets: ODDS_API_MARKETS, oddsFormat: "decimal", dateFormat: "iso" }
  );
  if (!featuredResult.ok || !featuredResult.data?.id) return null;

  let event = featuredResult.data;
  try {
    const additional = await fetchAdditionalSoccerMarkets(parsed.sportKey, parsed.eventId);
    if (additional.ok && additional.data) event = mergeBookmakerMarkets(event, additional.data);
  } catch (_) {}

  return {
    markets: normalizeOdds(event),
    raw: event,
    headers: featuredResult.headers
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

  if (!match) {

    return {
      valid: false,
      message:
        "Match not found."
    };
  }

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

  if (
    !match.external_id
  ) {

    return {
      valid: false,
      message:
        "Match data is incomplete."
    };
  }

  const oddsData =
    await getServerOddsForMatch(
      match.external_id
    );

  if (!oddsData) {

    return {
      valid: false,
      message:
        "Current odds are unavailable for this match."
    };
  }

  const found =
    findSelectionInMarkets(
      oddsData.markets,
      selection
    );

  if (!found) {

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

  if (
    !Number.isFinite(
      submittedOdds
    ) ||
    submittedOdds <= 1
  ) {

    return {
      valid: false,
      message:
        "Submitted odds are invalid."
    };
  }

  if (
    Math.abs(
      currentOdds -
      submittedOdds
    ) > 0.0001
  ) {

    return {
      valid: false,
      message:
        "The odds have changed. Please select the bet again.",
      odds_changed:
        true,
      old_odds:
        submittedOdds,
      current_odds:
        currentOdds
    };
  }

  return {
    valid: true,
    odds:
      currentOdds,
    selection:
      found.selection,
    market:
      found.market,
    bookmaker_key:
      found.item?.bookmaker_key ||
      null,
    bookmaker_title:
      found.item?.bookmaker_title ||
      null,
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
          "⚽ The Odds API:",
          ODDS_API_KEY
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
