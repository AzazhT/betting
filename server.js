
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const BSD_API_KEY = process.env.BSD_API_KEY;
const BSD_BASE_URL = (
  process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2"
).replace(/\/+$/, "");

const BSD_API_URL = process.env.BSD_API_URL || `${BSD_BASE_URL}/events/`;
const BSD_LIVE_URL = process.env.BSD_LIVE_URL || `${BSD_BASE_URL}/events/live/`;
const BSD_LEAGUES_URL = process.env.BSD_LEAGUES_URL || `${BSD_BASE_URL}/leagues/`;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ==================================================
// DEMO WALLET — memory only; resets after restart.
// Not suitable for real-money betting.
// ==================================================

const demoWallets = new Map();

function getWallet(userId = "demo") {
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

// ==================================================
// GENERAL HELPERS
// ==================================================

function firstValue(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  ) ?? null;
}

function numberValue(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "object") return fallback;

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function textValue(...values) {
  const value = firstValue(...values);

  if (value === null) return "";

  if (typeof value === "object") {
    return String(
      firstValue(
        value.name,
        value.title,
        value.label,
        value.short_name,
        value.shortName,
        value.display_name
      ) || ""
    );
  }

  return String(value);
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  for (const key of [
    "results", "data", "events", "fixtures",
    "matches", "items", "response", "leagues", "odds"
  ]) {
    if (Array.isArray(data[key])) return data[key];

    if (data[key] && typeof data[key] === "object") {
      for (const nested of [
        "results", "data", "items", "events", "leagues", "odds"
      ]) {
        if (Array.isArray(data[key][nested])) {
          return data[key][nested];
        }
      }
    }
  }

  return [];
}

function safeErrorDetails(error) {
  if (error.status) return `BSD HTTP ${error.status}`;
  return "Request failed";
}

// ==================================================
// BSD API REQUEST
// ==================================================

async function fetchBSD(url) {
  if (!BSD_API_KEY) {
    throw new Error("BSD_API_KEY is not configured");
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  const rawText = await response.text();

  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { raw: rawText };
  }

  if (!response.ok) {
    const error = new Error(`BSD API returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

// ==================================================
// TEAM NORMALIZATION
// ==================================================

function normalizeTeam(team) {
  if (!team) return { id: null, name: "", logo: "" };

  if (typeof team === "string") {
    return { id: null, name: team, logo: "" };
  }

  return {
    id: firstValue(team.id, team.team_id, team.teamId, team.uuid),
    name: textValue(
      team.name, team.team_name, team.teamName,
      team.title, team.display_name
    ),
    logo: textValue(
      team.logo, team.logo_url, team.logoUrl,
      team.image, team.crest
    )
  };
}

// ==================================================
// MATCH STATUS
// ==================================================

function normalizeStatus(event) {
  const raw = textValue(
    event.status,
    event.state,
    event.match_status,
    event.event_status,
    event.status_name,
    event.fixture_status
  );

  const status = raw.toLowerCase().replace(/[_-]+/g, " ").trim();

  if (
    /\b(finished|complete|completed|full time|ft|ended|after extra time|after penalties)\b/.test(status)
  ) {
    return { status: "finished", live: false };
  }

  if (
    /\b(live|in progress|inprogress|inplay|in play|playing|1st half|2nd half|half time|halftime|extra time)\b/.test(status)
  ) {
    return { status: "inprogress", live: true };
  }

  if (/\b(postponed|cancelled|canceled|abandoned|suspended)\b/.test(status)) {
    return { status: status.replace(/\s+/g, "_"), live: false };
  }

  const liveFlag =
    event.live === true ||
    event.is_live === true ||
    event.isLive === true;

  return {
    status: liveFlag ? (raw || "inprogress") : (raw || "upcoming"),
    live: liveFlag
  };
}

// ==================================================
// ODDS NORMALIZATION
// ==================================================

function emptyOdds() {
  return {
    "1": null,
    X: null,
    "2": null,
    doubleChance: { "1X": null, X2: null, "12": null },
    over15: null,
    under15: null,
    over25: null,
    under25: null,
    over35: null,
    under35: null,
    bttsYes: null,
    bttsNo: null
  };
}

// Handles odds embedded directly inside an event object.
function normalizeEmbeddedOdds(event) {
  const source = firstValue(
    event.odds,
    event.prices,
    event.markets,
    event.bets
  ) || {};

  const result = emptyOdds();

  result["1"] = numberValue(firstValue(
    event.home_odds, event.homeOdds, event.odds_home,
    source.home, source.home_win, source.home_odds, source["1"]
  ));

  result.X = numberValue(firstValue(
    event.draw_odds, event.drawOdds, event.odds_draw,
    source.draw, source.draw_odds, source.X, source.x
  ));

  result["2"] = numberValue(firstValue(
    event.away_odds, event.awayOdds, event.odds_away,
    source.away, source.away_win, source.away_odds, source["2"]
  ));

  result.over15 = numberValue(firstValue(source.over_15_goals, source.over15));
  result.under15 = numberValue(firstValue(source.under_15_goals, source.under15));
  result.over25 = numberValue(firstValue(source.over_25_goals, source.over25, source.over_2_5));
  result.under25 = numberValue(firstValue(source.under_25_goals, source.under25, source.under_2_5));
  result.over35 = numberValue(firstValue(source.over_35_goals, source.over35));
  result.under35 = numberValue(firstValue(source.under_35_goals, source.under35));
  result.bttsYes = numberValue(firstValue(source.btts_yes, source.bttsYes));
  result.bttsNo = numberValue(firstValue(source.btts_no, source.bttsNo));

  result.doubleChance["1X"] = numberValue(source["1X"]);
  result.doubleChance.X2 = numberValue(source.X2);
  result.doubleChance["12"] = numberValue(source["12"]);

  return result;
}

// Handles the BSD /odds/?event_id=... response.
// Example: market=1x2, outcome=HOME, decimal_odds=1.347
function normalizeOddsFeed(rows) {
  const result = emptyOdds();

  for (const row of rows) {
    const market = textValue(row.market, row.market_name)
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    const outcome = textValue(row.outcome, row.outcome_name)
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    const odds = numberValue(
      firstValue(row.decimal_odds, row.decimalOdds, row.odds, row.price)
    );

    if (odds === null || odds <= 1) continue;

    if (["1x2", "match_winner", "full_time_result", "winner"].includes(market)) {
      if (["home", "home_win", "1"].includes(outcome)) result["1"] = odds;
      if (["draw", "tie", "x"].includes(outcome)) result.X = odds;
      if (["away", "away_win", "2"].includes(outcome)) result["2"] = odds;
    }

    if (market === "double_chance") {
      if (outcome === "1x" || outcome === "home_or_draw") result.doubleChance["1X"] = odds;
      if (outcome === "x2" || outcome === "draw_or_away") result.doubleChance.X2 = odds;
      if (outcome === "12" || outcome === "home_or_away") result.doubleChance["12"] = odds;
    }

    if (["over_under_15", "over_under_1_5", "totals_15"].includes(market)) {
      if (outcome === "over") result.over15 = odds;
      if (outcome === "under") result.under15 = odds;
    }

    if (["over_under_25", "over_under_2_5", "totals_25"].includes(market)) {
      if (outcome === "over") result.over25 = odds;
      if (outcome === "under") result.under25 = odds;
    }

    if (["over_under_35", "over_under_3_5", "totals_35"].includes(market)) {
      if (outcome === "over") result.over35 = odds;
      if (outcome === "under") result.under35 = odds;
    }

    if (["btts", "both_teams_to_score"].includes(market)) {
      if (["yes", "btts_yes"].includes(outcome)) result.bttsYes = odds;
      if (["no", "btts_no"].includes(outcome)) result.bttsNo = odds;
    }

    // Some BSD feeds encode the market directly in the market name.
    if (market === "btts_yes") result.bttsYes = odds;
    if (market === "btts_no") result.bttsNo = odds;
  }

  return result;
}

function hasMainOdds(odds) {
  return odds &&
    odds["1"] !== null &&
    odds.X !== null &&
    odds["2"] !== null;
}

// ==================================================
// EVENT NORMALIZATION
// ==================================================

function normalizeEvent(event, index = 0) {
  event = event && typeof event === "object" ? event : {};

  const teams = event.teams || {};

  const homeTeam = normalizeTeam(firstValue(
    event.home, event.home_team, event.homeTeam,
    event.team_home, teams.home, event.localteam
  ));

  const awayTeam = normalizeTeam(firstValue(
    event.away, event.away_team, event.awayTeam,
    event.team_away, teams.away, event.visitorteam
  ));

  const homeName = textValue(
    homeTeam.name, event.home_name, event.homeTeamName, event.home_team_name
  );

  const awayName = textValue(
    awayTeam.name, event.away_name, event.awayTeamName, event.away_team_name
  );

  const id = firstValue(
    event.id, event.event_id, event.eventId,
    event.fixture_id, event.fixtureId,
    event.match_id, event.matchId, event.fixture?.id,
    `event-${index}`
  );

  const league = textValue(
    event.league,
    event.competition,
    event.tournament,
    event.league_name,
    event.competition_name,
    event.tournament_name,
    event.league?.name,
    event.competition?.name
  ) || "Football";

  const startTime = firstValue(
    event.start_time, event.startTime, event.starts_at,
    event.start, event.date, event.datetime,
    event.kickoff, event.kickoff_time,
    event.scheduled_at, event.event_date, event.fixture?.date
  );

  const normalizedStatus = normalizeStatus(event);
  const scoreSource = event.score || event.scores || {};

  const homeScore = firstValue(
    event.home_score, event.homeScore, scoreSource.home,
    scoreSource.localteam, scoreSource.home_score, event.goals?.home
  );

  const awayScore = firstValue(
    event.away_score, event.awayScore, scoreSource.away,
    scoreSource.visitorteam, scoreSource.away_score, event.goals?.away
  );

  return {
    id: String(id),
    league,
    home: {
      id: homeTeam.id,
      name: homeName || "Home",
      logo: homeTeam.logo || ""
    },
    away: {
      id: awayTeam.id,
      name: awayName || "Away",
      logo: awayTeam.logo || ""
    },
    startTime,
    status: normalizedStatus.status,
    live: normalizedStatus.live,
    score: {
      home: numberValue(homeScore, 0),
      away: numberValue(awayScore, 0)
    },
    odds: normalizeEmbeddedOdds(event)
  };
}

// ==================================================
// ODDS LOOKUP + CACHE
// ==================================================

const oddsCache = new Map();
const ODDS_CACHE_MS = 5 * 60 * 1000;

async function getEventOdds(eventId) {
  const id = String(eventId);
  const cached = oddsCache.get(id);

  if (cached && Date.now() - cached.time < ODDS_CACHE_MS) {
    return cached.odds;
  }

  try {
    const params = new URLSearchParams({
      event_id: id,
      limit: "100"
    });

    const data = await fetchBSD(`${BSD_BASE_URL}/odds/?${params.toString()}`);
    const rows = asArray(data);
    const odds = normalizeOddsFeed(rows);

    // Use the event-specific odds endpoint as a fallback if feed is empty.
    if (!rows.length || !hasMainOdds(odds)) {
      try {
        const detail = await fetchBSD(
          `${BSD_BASE_URL}/events/${encodeURIComponent(id)}/odds/`
        );

        const source = detail?.odds && typeof detail.odds === "object"
          ? detail.odds
          : {};

        odds["1"] = odds["1"] ?? numberValue(source.home_win);
        odds.X = odds.X ?? numberValue(source.draw);
        odds["2"] = odds["2"] ?? numberValue(source.away_win);

        odds.over15 = odds.over15 ?? numberValue(source.over_15_goals);
        odds.under15 = odds.under15 ?? numberValue(source.under_15_goals);
        odds.over25 = odds.over25 ?? numberValue(source.over_25_goals);
        odds.under25 = odds.under25 ?? numberValue(source.under_25_goals);
        odds.over35 = odds.over35 ?? numberValue(source.over_35_goals);
        odds.under35 = odds.under35 ?? numberValue(source.under_35_goals);
        odds.bttsYes = odds.bttsYes ?? numberValue(source.btts_yes);
        odds.bttsNo = odds.bttsNo ?? numberValue(source.btts_no);
      } catch (fallbackError) {
        console.warn(`BSD detailed odds fallback for ${id}:`, fallbackError.message);
      }
    }

    oddsCache.set(id, { time: Date.now(), odds });
    return odds;
  } catch (error) {
    console.error(`Odds unavailable for event ${id}:`, error.message);
    return cached ? cached.odds : emptyOdds();
  }
}

function leagueName(league) {
  if (typeof league === "string") return league;

  return textValue(
    league?.name,
    league?.title,
    league?.league_name,
    league?.competition_name
  );
}

// ==================================================
// EVENTS
// Supports ?limit=50. Odds are loaded in small batches.
// ==================================================

app.get("/api/events", async (req, res) => {
  try {
    const data = await fetchBSD(BSD_API_URL);
    const rawEvents = asArray(data);
    const events = rawEvents.map(normalizeEvent);

    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : events.length;

    const selected = events.slice(0, limit);
    const batchSize = 5;

    for (let i = 0; i < selected.length; i += batchSize) {
      const batch = selected.slice(i, i + batchSize);

      await Promise.all(batch.map(async (event) => {
        if (!hasMainOdds(event.odds) && !event.id.startsWith("event-")) {
          event.odds = await getEventOdds(event.id);
        }
      }));
    }

    res.json({
      success: true,
      source: "BSD",
      count: selected.length,
      totalReturnedByBSD: events.length,
      events: selected,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("BSD EVENTS ERROR:", error.message);

    res.status(502).json({
      success: false,
      error: "Could not load football events from BSD.",
      details: safeErrorDetails(error),
      events: []
    });
  }
});

// ==================================================
// LIVE EVENTS
// ==================================================

app.get("/api/live", async (req, res) => {
  try {
    const data = await fetchBSD(BSD_LIVE_URL);
    const events = asArray(data).map(normalizeEvent);

    res.json({
      success: true,
      source: "BSD",
      count: events.length,
      events,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("BSD LIVE ERROR:", error.message);

    res.status(502).json({
      success: false,
      error: "Could not load live events from BSD.",
      details: safeErrorDetails(error),
      events: []
    });
  }
});

// ==================================================
// LEAGUES
// ==================================================

app.get("/api/leagues", async (req, res) => {
  try {
    const data = await fetchBSD(BSD_LEAGUES_URL);

    const leagues = asArray(data)
      .map((item) => ({
        id: firstValue(item.id, item.league_id, item.competition_id),
        name: leagueName(item)
      }))
      .filter((item) => item.name);

    res.json({
      success: true,
      source: "BSD",
      count: leagues.length,
      leagues
    });
  } catch (error) {
    console.error("BSD LEAGUES ERROR:", error.message);

    res.status(502).json({
      success: false,
      error: "Could not load leagues from BSD.",
      details: safeErrorDetails(error),
      leagues: []
    });
  }
});

// ==================================================
// NORMALIZED ODDS FOR ONE EVENT
// ==================================================

app.get("/api/odds/:eventId", async (req, res) => {
  try {
    const eventId = String(req.params.eventId);
    const odds = await getEventOdds(eventId);

    res.json({
      success: true,
      source: "BSD",
      eventId,
      odds
    });
  } catch (error) {
    console.error("BSD ODDS ERROR:", error.message);

    res.status(502).json({
      success: false,
      error: "Could not load odds.",
      details: safeErrorDetails(error)
    });
  }
});

// ==================================================
// RAW ODDS FEED FOR DEBUGGING
// ==================================================

app.get("/api/odds-feed/:eventId", async (req, res) => {
  try {
    const params = new URLSearchParams({
      event_id: String(req.params.eventId),
      limit: "100"
    });

    const data = await fetchBSD(`${BSD_BASE_URL}/odds/?${params.toString()}`);

    res.json({
      success: true,
      source: "BSD",
      eventId: String(req.params.eventId),
      data
    });
  } catch (error) {
    console.error("BSD ODDS FEED ERROR:", error.message);

    res.status(502).json({
      success: false,
      error: "Could not load BSD odds feed.",
      details: safeErrorDetails(error)
    });
  }
});

// ==================================================
// DEMO WALLET
// ==================================================

app.get("/api/wallet", (req, res) => {
  const wallet = getWallet(req.query.userId || "demo");

  res.json({
    success: true,
    wallet: {
      userId: wallet.userId,
      balance: wallet.balance,
      bonus: wallet.bonus
    }
  });
});

// ==================================================
// PLACE DEMO BET
// ==================================================

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

    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      return res.status(400).json({
        success: false,
        error: "Invalid stake."
      });
    }

    const wallet = getWallet(userId);

    if (wallet.balance < amount) {
      return res.status(400).json({
        success: false,
        error: "Insufficient balance."
      });
    }

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

    const bet = {
      id: `BET-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: String(userId),
      stake: amount,
      combinedOdds,
      potentialWin: amount * combinedOdds,
      status: "PENDING",
      selections: cleanSelections,
      createdAt: new Date().toISOString()
    };

    wallet.balance -= amount;
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
    console.error("BET ERROR:", error.message);

    res.status(400).json({
      success: false,
      error: error.message || "Could not place bet."
    });
  }
});

// ==================================================
// BET HISTORY
// ==================================================

app.get("/api/bets", (req, res) => {
  const wallet = getWallet(req.query.userId || "demo");

  res.json({
    success: true,
    bets: wallet.bets
  });
});

// ==================================================
// HEALTH CHECK
// ==================================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "football-betting",
    time: new Date().toISOString(),
    bsdConfigured: Boolean(BSD_API_KEY)
  });
});

// ==================================================
// HOME PAGE
// ==================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "betting.html"));
});

// ==================================================
// 404 + ERROR HANDLERS
// ==================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found."
  });
});

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);

  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

// ==================================================
// START SERVER
// ==================================================

app.listen(PORT, () => {
  console.log(`Football Betting server running on port ${PORT}`);
  console.log(`BSD API configured: ${Boolean(BSD_API_KEY)}`);
  console.log(`BSD events endpoint: ${BSD_API_URL}`);
  console.log(`BSD live endpoint: ${BSD_LIVE_URL}`);
  console.log(`BSD odds feed endpoint: ${BSD_BASE_URL}/odds/`);
});
