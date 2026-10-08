const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

const BSD_API_KEY = process.env.BSD_API_KEY;

// You can change this from Render Environment if BSD gives you another endpoint.
const BSD_API_URL =
  process.env.BSD_API_URL ||
  "https://sports.bzzoiro.com/api/v2/events/live/";

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   DEMO WALLET
   ========================================================= */

const demoWallets = new Map();

function getWallet(userId) {
  const id = String(userId || "demo");

  if (!demoWallets.has(id)) {
    demoWallets.set(id, {
      userId: id,
      balance: 1000,
      bonus: 0,
      bets: []
    });
  }

  return demoWallets.get(id);
}

/* =========================================================
   HELPERS
   ========================================================= */

function numberValue(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return null;
}

function textValue(...values) {
  const value = firstValue(...values);

  if (value === null) {
    return "";
  }

  if (typeof value === "object") {
    return String(
      firstValue(
        value.name,
        value.title,
        value.label,
        value.short_name,
        value.shortName
      ) || ""
    );
  }

  return String(value);
}

/* =========================================================
   BSD API REQUEST
   ========================================================= */

async function fetchBSD(url) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured");
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json"
    }
  });

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    data = {
      raw: rawText
    };
  }

  if (!response.ok) {
    const error = new Error(
      `BSD API returned HTTP ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

/* =========================================================
   EXTRACT ARRAY FROM DIFFERENT BSD RESPONSE SHAPES
   ========================================================= */

function extractArray(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== "object") {
    return [];
  }

  const possibleArrays = [
    data.results,
    data.data,
    data.events,
    data.fixtures,
    data.matches,
    data.items,
    data.response
  ];

  for (const item of possibleArrays) {
    if (Array.isArray(item)) {
      return item;
    }
  }

  return [];
}

/* =========================================================
   NORMALIZE TEAM
   ========================================================= */

function normalizeTeam(team) {
  if (!team) {
    return {
      id: null,
      name: ""
    };
  }

  if (typeof team === "string") {
    return {
      id: null,
      name: team
    };
  }

  return {
    id: firstValue(
      team.id,
      team.team_id,
      team.teamId,
      team.uuid
    ),

    name: textValue(
      team.name,
      team.team_name,
      team.teamName,
      team.title
    ),

    logo: textValue(
      team.logo,
      team.logo_url,
      team.logoUrl,
      team.image
    )
  };
}

/* =========================================================
   NORMALIZE ODDS
   ========================================================= */

function normalizeOdds(event) {
  const source =
    event.odds ||
    event.markets ||
    event.bets ||
    event.prices ||
    {};

  let home = null;
  let draw = null;
  let away = null;

  let over = null;
  let under = null;

  let bttsYes = null;
  let bttsNo = null;

  /*
   * Direct odds fields
   */

  home = numberValue(
    firstValue(
      event.home_odds,
      event.homeOdds,
      event.odds_home,
      event.home_price
    )
  );

  draw = numberValue(
    firstValue(
      event.draw_odds,
      event.drawOdds,
      event.odds_draw,
      event.draw_price
    )
  );

  away = numberValue(
    firstValue(
      event.away_odds,
      event.awayOdds,
      event.odds_away,
      event.away_price
    )
  );

  /*
   * Search markets recursively.
   */

  function scan(obj) {
    if (!obj || typeof obj !== "object") {
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        scan(item);
      }

      return;
    }

    const marketName = textValue(
      obj.market,
      obj.market_name,
      obj.marketName,
      obj.name,
      obj.type,
      obj.label
    ).toLowerCase();

    const selectionName = textValue(
      obj.selection,
      obj.selection_name,
      obj.selectionName,
      obj.outcome,
      obj.outcome_name,
      obj.label,
      obj.name
    ).toLowerCase();

    const price = numberValue(
      firstValue(
        obj.odds,
        obj.odd,
        obj.price,
        obj.value,
        obj.rate
      )
    );

    if (price !== null) {
      /*
       * 1X2
       */

      if (
        marketName.includes("1x2") ||
        marketName.includes("match winner") ||
        marketName.includes("winner") ||
        marketName.includes("full time")
      ) {
        if (
          selectionName === "1" ||
          selectionName.includes("home")
        ) {
          home = home || price;
        }

        if (
          selectionName === "x" ||
          selectionName.includes("draw")
        ) {
          draw = draw || price;
        }

        if (
          selectionName === "2" ||
          selectionName.includes("away")
        ) {
          away = away || price;
        }
      }

      /*
       * Over / Under
       */

      if (
        marketName.includes("over") ||
        marketName.includes("under") ||
        marketName.includes("total")
      ) {
        if (selectionName.includes("over")) {
          over = over || price;
        }

        if (selectionName.includes("under")) {
          under = under || price;
        }
      }

      /*
       * BTTS
       */

      if (
        marketName.includes("both teams") ||
        marketName.includes("btts")
      ) {
        if (selectionName === "yes") {
          bttsYes = bttsYes || price;
        }

        if (selectionName === "no") {
          bttsNo = bttsNo || price;
        }
      }
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        scan(value);
      }
    }
  }

  scan(source);

  return {
    "1": home,
    X: draw,
    "2": away,

    over,
    under,

    bttsYes,
    bttsNo
  };
}

/* =========================================================
   NORMALIZE EVENT
   ========================================================= */

function normalizeEvent(event, index) {
  const homeTeam = normalizeTeam(
    firstValue(
      event.home,
      event.home_team,
      event.homeTeam,
      event.team_home,
      event.teams?.home
    )
  );

  const awayTeam = normalizeTeam(
    firstValue(
      event.away,
      event.away_team,
      event.awayTeam,
      event.team_away,
      event.teams?.away
    )
  );

  const homeName = textValue(
    homeTeam.name,
    event.home_name,
    event.homeTeamName,
    event.home_team_name
  );

  const awayName = textValue(
    awayTeam.name,
    event.away_name,
    event.awayTeamName,
    event.away_team_name
  );

  const id = firstValue(
    event.id,
    event.event_id,
    event.eventId,
    event.fixture_id,
    event.fixtureId,
    event.match_id,
    event.matchId,
    `event-${index}`
  );

  const league =
    textValue(
      event.league,
      event.competition,
      event.tournament,
      event.league_name,
      event.competition_name,
      event.tournament_name
    ) || "Football";

  const startTime = firstValue(
    event.start_time,
    event.startTime,
    event.starts_at,
    event.start,
    event.date,
    event.datetime,
    event.kickoff
  );

  const status = textValue(
    event.status,
    event.state,
    event.match_status
  );

  const isLive =
    event.live === true ||
    event.is_live === true ||
    event.isLive === true ||
    /live|playing|in.?play|1st|2nd|half/i.test(status);

  const odds = normalizeOdds(event);

  return {
    id: String(id),

    league,

    home: {
      id: homeTeam.id,
      name: homeName || "Home"
    },

    away: {
      id: awayTeam.id,
      name: awayName || "Away"
    },

    startTime,

    status: status || (isLive ? "LIVE" : "UPCOMING"),

    live: isLive,

    score: {
      home: numberValue(
        firstValue(
          event.home_score,
          event.homeScore,
          event.score?.home,
          event.scores?.home
        ),
        0
      ),

      away: numberValue(
        firstValue(
          event.away_score,
          event.awayScore,
          event.score?.away,
          event.scores?.away
        ),
        0
      )
    },

    odds
  };
}

/* =========================================================
   GET EVENTS
   ========================================================= */

app.get("/api/events", async (req, res) => {
  try {
    const data = await fetchBSD(BSD_API_URL);

    const rawEvents = extractArray(data);

    const events = rawEvents.map((event, index) =>
      normalizeEvent(event, index)
    );

    res.json({
      success: true,

      source: "BSD",

      count: events.length,

      events,

      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("BSD ERROR:", error.message);

    res.status(502).json({
      success: false,

      error: "Could not load football events from BSD.",

      details: error.message,

      events: []
    });
  }
});

/* =========================================================
   WALLET
   ========================================================= */

app.get("/api/wallet", (req, res) => {
  const userId = req.query.userId || "demo";

  const wallet = getWallet(userId);

  res.json({
    success: true,

    wallet: {
      userId: wallet.userId,
      balance: wallet.balance,
      bonus: wallet.bonus
    }
  });
});

/* =========================================================
   PLACE DEMO BET
   ========================================================= */

app.post("/api/bet", (req, res) => {
  try {
    const {
      userId = "demo",
      selections = [],
      stake
    } = req.body || {};

    const amount = Number(stake);

    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Please select at least one market."
      });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid stake."
      });
    }

    if (amount > 1000000) {
      return res.status(400).json({
        success: false,
        error: "Stake is too large."
      });
    }

    const wallet = getWallet(userId);

    if (wallet.balance < amount) {
      return res.status(400).json({
        success: false,
        error: "Insufficient balance."
      });
    }

    /*
     * Calculate combined odds.
     */

    let combinedOdds = 1;

    const cleanSelections = selections.map((selection) => {
      const odds = Number(selection.odds);

      if (!Number.isFinite(odds) || odds <= 1) {
        throw new Error("Invalid odds.");
      }

      combinedOdds *= odds;

      return {
        eventId: String(selection.eventId || ""),
        match: String(selection.match || ""),
        market: String(selection.market || ""),
        selection: String(selection.selection || ""),
        odds
      };
    });

    const potentialWin = amount * combinedOdds;

    wallet.balance -= amount;

    const bet = {
      id:
        "BET-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2, 8),

      userId: String(userId),

      stake: amount,

      combinedOdds,

      potentialWin,

      status: "PENDING",

      selections: cleanSelections,

      createdAt: new Date().toISOString()
    };

    wallet.bets.unshift(bet);

    res.json({
      success: true,

      message: "Demo bet placed successfully.",

      bet,

      wallet: {
        balance: wallet.balance,
        bonus: wallet.bonus
      }
    });
  } catch (error) {
    console.error("BET ERROR:", error);

    res.status(400).json({
      success: false,
      error: error.message || "Could not place bet."
    });
  }
});

/* =========================================================
   BET HISTORY
   ========================================================= */

app.get("/api/bets", (req, res) => {
  const userId = req.query.userId || "demo";

  const wallet = getWallet(userId);

  res.json({
    success: true,
    bets: wallet.bets
  });
});

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "football-betting",
    time: new Date().toISOString(),
    bsdConfigured: Boolean(BSD_API_KEY)
  });
});

/* =========================================================
   MAIN PAGE
   ========================================================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "betting.html")
  );
});

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(PORT, () => {
  console.log(
    `Football Betting server running on port ${PORT}`
  );

  console.log(
    `BSD API configured: ${Boolean(BSD_API_KEY)}`
  );

  console.log(
    `BSD endpoint: ${BSD_API_URL}`
  );
});
