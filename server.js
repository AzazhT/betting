const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const BSD_API_KEY = process.env.BSD_API_KEY;
const BSD_BASE_URL = (process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2").replace(/\/+$/, "");
const BSD_API_URL = process.env.BSD_API_URL || `${BSD_BASE_URL}/events/`;
const BSD_LIVE_URL = process.env.BSD_LIVE_URL || `${BSD_BASE_URL}/events/live/`;
const BSD_LEAGUES_URL = process.env.BSD_LEAGUES_URL || `${BSD_BASE_URL}/leagues/`;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/*
 * DEMO WALLET ONLY:
 * This wallet is stored in memory and resets when the server restarts.
 * It is not a real-money wallet and is not suitable for production.
 */
const demoWallets = new Map();

function getWallet(userId) {
  const id = String(userId || "demo");
  if (!demoWallets.has(id)) {
    demoWallets.set(id, { userId: id, balance: 1000, bonus: 0, bets: [] });
  }
  return demoWallets.get(id);
}

function numberValue(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function textValue(...values) {
  const value = firstValue(...values);
  if (value === null) return "";
  if (typeof value === "object") {
    return String(firstValue(
      value.name, value.title, value.label, value.short_name,
      value.shortName, value.display_name
    ) || "");
  }
  return String(value);
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["results", "data", "events", "fixtures", "matches", "items", "response", "leagues"]) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === "object") {
      for (const nestedKey of ["results", "data", "items", "events", "leagues"]) {
        if (Array.isArray(data[key][nestedKey])) return data[key][nestedKey];
      }
    }
  }
  return [];
}

async function fetchBSD(url) {
  if (!BSD_API_KEY) throw new Error("BSD_API_KEY is not configured");

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
    // Do not include request headers or API key in errors/logs.
    error.data = data;
    throw error;
  }
  return data;
}

function normalizeTeam(team) {
  if (!team) return { id: null, name: "", logo: "" };
  if (typeof team === "string") return { id: null, name: team, logo: "" };
  return {
    id: firstValue(team.id, team.team_id, team.teamId, team.uuid),
    name: textValue(team.name, team.team_name, team.teamName, team.title, team.display_name),
    logo: textValue(team.logo, team.logo_url, team.logoUrl, team.image, team.crest)
  };
}

function normalizeStatus(event) {
  const raw = textValue(
    event.status, event.state, event.match_status, event.event_status,
    event.status_name, event.fixture_status
  );
  const s = raw.toLowerCase().replace(/[_-]+/g, " ").trim();

  if (/\b(finished|complete|completed|full time|ft|ended|after extra time|after penalties)\b/.test(s)) {
    return { status: "finished", live: false };
  }
  if (/\b(live|in progress|inplay|in play|playing|1st half|2nd half|half time|halftime|extra time)\b/.test(s)) {
    return { status: "inprogress", live: true };
  }
  if (/\b(postponed|cancelled|canceled|abandoned|suspended)\b/.test(s)) {
    return { status: s.replace(/\s+/g, "_"), live: false };
  }

  const isLiveFlag = event.live === true || event.is_live === true || event.isLive === true;
  if (isLiveFlag) return { status: raw || "inprogress", live: true };
  return { status: raw || "upcoming", live: false };
}

function normalizeOdds(event) {
  const source = firstValue(event.odds, event.prices, event.markets, event.bets) || {};
  const odds = {
    "1": null, X: null, "2": null,
    over: null, under: null, bttsYes: null, bttsNo: null
  };

  // Direct fields, if supplied by the event endpoint.
  odds["1"] = numberValue(firstValue(
    event.home_odds, event.homeOdds, event.odds_home, event.home_price,
    source.home, source.home_win, source.home_odds, source["1"], source["1x2"]?.["1"]
  ));
  odds.X = numberValue(firstValue(
    event.draw_odds, event.drawOdds, event.odds_draw, event.draw_price,
    source.draw, source.draw_odds, source.X, source.x, source["1x2"]?.X
  ));
  odds["2"] = numberValue(firstValue(
    event.away_odds, event.awayOdds, event.odds_away, event.away_price,
    source.away, source.away_win, source.away_odds, source["2"], source["1x2"]?.["2"]
  ));
  odds.over = numberValue(firstValue(event.over_odds, source.over, source.over_25, source.over_2_5));
  odds.under = numberValue(firstValue(event.under_odds, source.under, source.under_25, source.under_2_5));
  odds.bttsYes = numberValue(firstValue(source.btts_yes, source.bttsYes, event.btts_yes));
  odds.bttsNo = numberValue(firstValue(source.btts_no, source.bttsNo, event.btts_no));

  // Some providers return markets/outcomes as arrays or nested objects.
  function scan(node, marketContext = "") {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) scan(item, marketContext);
      return;
    }

    const market = textValue(
      node.market, node.market_name, node.marketName, node.market_type,
      node.type, node.name, node.label
    ).toLowerCase();
    const context = `${marketContext} ${market}`.toLowerCase();
    const selection = textValue(
      node.selection, node.selection_name, node.selectionName, node.outcome,
      node.outcome_name, node.runner_name, node.label, node.name
    ).toLowerCase();
    const price = numberValue(firstValue(
      node.odds, node.odd, node.price, node.decimal_odds, node.decimalOdds, node.rate
    ));

    if (price !== null && price > 1) {
      if (/1x2|match result|match winner|full time result|winner/.test(context)) {
        if (/^(1|home|home win|1x2 home)$/.test(selection) || selection.includes("home")) odds["1"] ??= price;
        if (/^(x|draw|tie)$/.test(selection) || selection.includes("draw")) odds.X ??= price;
        if (/^(2|away|away win|1x2 away)$/.test(selection) || selection.includes("away")) odds["2"] ??= price;
      }
      if (/over.?under|total goals|goals total/.test(context)) {
        if (selection.includes("over")) odds.over ??= price;
        if (selection.includes("under")) odds.under ??= price;
      }
      if (/both teams to score|btts/.test(context)) {
        if (selection === "yes") odds.bttsYes ??= price;
        if (selection === "no") odds.bttsNo ??= price;
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") scan(value, `${context} ${key}`);
    }
  }
  scan(source);

  return odds;
}

function normalizeEvent(event, index = 0) {
  event = event && typeof event === "object" ? event : {};

  const teams = event.teams || {};
  const homeTeam = normalizeTeam(firstValue(
    event.home, event.home_team, event.homeTeam, event.team_home, teams.home, event.localteam
  ));
  const awayTeam = normalizeTeam(firstValue(
    event.away, event.away_team, event.awayTeam, event.team_away, teams.away, event.visitorteam
  ));

  const homeName = textValue(homeTeam.name, event.home_name, event.homeTeamName, event.home_team_name);
  const awayName = textValue(awayTeam.name, event.away_name, event.awayTeamName, event.away_team_name);

  const id = firstValue(
    event.id, event.event_id, event.eventId, event.fixture_id, event.fixtureId,
    event.match_id, event.matchId, event.fixture?.id, `event-${index}`
  );

  const league = textValue(
    event.league, event.competition, event.tournament, event.league_name,
    event.competition_name, event.tournament_name, event.league?.name
  ) || "Football";

  const startTime = firstValue(
    event.start_time, event.startTime, event.starts_at, event.start,
    event.date, event.datetime, event.kickoff, event.kickoff_time,
    event.scheduled_at, event.event_date, event.fixture?.date
  );

  const normalizedStatus = normalizeStatus(event);
  const scoreSource = event.score || event.scores || {};
  const homeScore = firstValue(
    event.home_score, event.homeScore, scoreSource.home, scoreSource.localteam,
    scoreSource.home_score, event.goals?.home
  );
  const awayScore = firstValue(
    event.away_score, event.awayScore, scoreSource.away, scoreSource.visitorteam,
    scoreSource.away_score, event.goals?.away
  );

  return {
    id: String(id),
    league,
    home: { id: homeTeam.id, name: homeName || "Home", logo: homeTeam.logo || "" },
    away: { id: awayTeam.id, name: awayName || "Away", logo: awayTeam.logo || "" },
    startTime,
    status: normalizedStatus.status,
    live: normalizedStatus.live,
    score: {
      home: numberValue(homeScore, 0),
      away: numberValue(awayScore, 0)
    },
    odds: normalizeOdds(event)
  };
}

function leagueName(league) {
  return textValue(
    league.name, league.title, league.league_name, league.competition_name,
    typeof league === "string" ? league : null
  );
}

app.get("/api/events", async (req, res) => {
  try {
    const data = await fetchBSD(BSD_API_URL);
    const rawEvents = asArray(data);
    const events = rawEvents.map(normalizeEvent);

    res.json({
      success: true,
      source: "BSD",
      count: events.length,
      events,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("BSD EVENTS ERROR:", error.message);
    res.status(502).json({
      success: false,
      error: "Could not load football events from BSD.",
      details: error.status ? `BSD HTTP ${error.status}` : "Request failed",
      events: []
    });
  }
});

app.get("/api/leagues", async (req, res) => {
  try {
    const data = await fetchBSD(BSD_LEAGUES_URL);
    const rawLeagues = asArray(data);
    const leagues = rawLeagues
      .map(item => ({
        id: firstValue(item.id, item.league_id, item.competition_id),
        name: leagueName(item)
      }))
      .filter(item => item.name);

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
      leagues: []
    });
  }
});

app.get("/api/live", async (req, res) => {
  try {
    const data = await fetchBSD(BSD_LIVE_URL);
    const rawEvents = asArray(data);
    const events = rawEvents.map(normalizeEvent);

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
      events: []
    });
  }
});
app.get("/api/odds/:eventId", async (req, res) => {
  try {
    const eventId = encodeURIComponent(req.params.eventId);
    const data = await fetchBSD(
      `${BSD_BASE_URL}/events/${eventId}/odds/`
    );
    res.json({ success: true, odds: data });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: "Could not load odds",
      details: error.status ? `BSD HTTP ${error.status}` : "Request failed"
    });
  }
});

// Fetch the BSD odds feed for one event.
// Diagnostic endpoint: it shows the raw response returned by BSD.
app.get("/api/odds-feed/:eventId", async (req, res) => {
  try {
    const eventId = encodeURIComponent(req.params.eventId);
    const params = new URLSearchParams({ event_id: eventId, limit: "100" });
    const data = await fetchBSD(`${BSD_BASE_URL}/odds/?${params.toString()}`);

    res.json({
      success: true,
      source: "BSD",
      eventId: req.params.eventId,
      data
    });
  } catch (error) {
    console.error("BSD ODDS FEED ERROR:", error.message);
    res.status(502).json({
      success: false,
      error: "Could not load odds feed from BSD.",
      details: error.status ? `BSD HTTP ${error.status}` : "Request failed"
    });
  }
});

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

app.post("/api/bet", (req, res) => {
  try {
    const { userId = "demo", selections = [], stake } = req.body || {};
    const amount = Number(stake);

    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(400).json({ success: false, error: "Please select at least one market." });
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      return res.status(400).json({ success: false, error: "Invalid stake." });
    }

    const wallet = getWallet(userId);
    if (wallet.balance < amount) {
      return res.status(400).json({ success: false, error: "Insufficient balance." });
    }

    let combinedOdds = 1;
    const cleanSelections = selections.map(selection => {
      const odds = Number(selection.odds);
      if (!Number.isFinite(odds) || odds <= 1) throw new Error("Invalid odds.");
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
      wallet: { balance: wallet.balance, bonus: wallet.bonus }
    });
  } catch (error) {
    console.error("BET ERROR:", error.message);
    res.status(400).json({ success: false, error: error.message || "Could not place bet." });
  }
});

app.get("/api/bets", (req, res) => {
  const wallet = getWallet(req.query.userId || "demo");
  res.json({ success: true, bets: wallet.bets });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "football-betting",
    time: new Date().toISOString(),
    bsdConfigured: Boolean(BSD_API_KEY)
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "betting.html"));
});

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);
  res.status(500).json({ success: false, error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`Football Betting server running on port ${PORT}`);
  console.log(`BSD API configured: ${Boolean(BSD_API_KEY)}`);
  console.log(`BSD events endpoint: ${BSD_API_URL}`);
  console.log(`BSD live endpoint: ${BSD_LIVE_URL}`);
  console.log(`BSD odds endpoint: ${BSD_BASE_URL}/odds/`);
});
