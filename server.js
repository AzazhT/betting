const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;
const TIME_ZONE = "Africa/Addis_Ababa";

const BSD_API_KEY = process.env.BSD_API_KEY;
const BSD_BASE_URL = (
  process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2"
).replace(/\/+$/, "");

const BSD_API_URL = process.env.BSD_API_URL || `${BSD_BASE_URL}/events/`;
const BSD_LIVE_URL = process.env.BSD_LIVE_URL || `${BSD_BASE_URL}/events/live/`;
const BSD_LEAGUES_URL = process.env.BSD_LEAGUES_URL || `${BSD_BASE_URL}/leagues/`;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// index.html ካለ betting.htmlን እንዳይተካው
app.use(express.static(path.join(__dirname, "public"), { index: false }));

function firstValue(...values) {
  return values.find(v => v !== undefined && v !== null && v !== "") ?? null;
}

function numberValue(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

  for (const key of [
    "results", "data", "events", "fixtures", "matches",
    "items", "response", "leagues", "odds"
  ]) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === "object") {
      for (const nested of ["results", "data", "items", "events", "leagues", "odds"]) {
        if (Array.isArray(data[key][nested])) return data[key][nested];
      }
    }
  }
  return [];
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function dateKey(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(d).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function tomorrowKey() {
  const today = dateKey(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// የAPI ቀንን ብቻ ይጠቀማል፤ ቀን አይፈጥርም።
// timezone የሌለው timestamp እዚህ UTC ተብሎ ይተረጎማል።
// BSD ሌላ timezone ከተጠቀመ ይህን ከሰነዱ ጋር አስተካክል።
function normalizeStartTime(value) {
  if (value === undefined || value === null || value === "") return null;

  let date;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    date = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    let text = String(value).trim().replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      // ሰዓት የሌለው ቀን፤ በኢትዮጵያ ቀን መጀመሪያ
      text += "T00:00:00+03:00";
    } else if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)
    ) {
      text += "Z";
    }
    date = new Date(text);
  }

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function fetchBSD(url) {
  if (!BSD_API_KEY) throw new Error("BSD_API_KEY is not configured");

  const response = await fetch(url, {
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const error = new Error(`BSD HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  // የተሳሳተ JSONን እንደ ባዶ ስኬታማ ምላሽ አንቆጥረውም።
  return response.json();
}

// API next ካቀረበ ተጨማሪ ገጾችን ያነባል።
// API keyን ወደ ሌላ origin አይልክም።
async function fetchPages(initialUrl) {
  const allowedOrigin = new URL(initialUrl).origin;
  const visited = new Set();
  const rows = [];
  let url = initialUrl;
  let truncated = false;

  for (let page = 0; url && page < 10; page++) {
    if (visited.has(url)) {
      truncated = true;
      break;
    }
    visited.add(url);

    const data = await fetchBSD(url);
    rows.push(...asArray(data));

    const next = firstValue(
      data?.next,
      data?.pagination?.next,
      data?.links?.next
    );

    if (typeof next !== "string" || !next) {
      url = null;
      break;
    }

    const resolved = new URL(next, url);
    if (resolved.origin !== allowedOrigin) {
      throw new Error("Unexpected pagination origin");
    }
    url = resolved.href;
  }

  if (url) truncated = true;
  return { rows, truncated };
}

function normalizeTeam(team) {
  if (!team) return { id: null, name: "", logo: "" };
  if (typeof team === "string") return { id: null, name: team, logo: "" };

  return {
    id: firstValue(team.id, team.team_id, team.teamId, team.uuid),
    name: textValue(team.name, team.team_name, team.teamName, team.title),
    logo: textValue(team.logo, team.logo_url, team.logoUrl, team.image, team.crest)
  };
}

function normalizeStatus(event) {
  const raw = textValue(
    event.status, event.state, event.match_status,
    event.event_status, event.status_name, event.fixture_status
  ).toLowerCase().replace(/[_-]+/g, " ").trim();

  if (/\b(finished|complete|completed|full time|ft|ended|after extra time|after penalties)\b/.test(raw)) {
    return { status: "finished", live: false };
  }
  if (/\b(postponed|cancelled|canceled|abandoned|suspended)\b/.test(raw)) {
    return { status: raw.replace(/\s+/g, "_"), live: false };
  }
  if (
    /\b(live|in progress|inprogress|inplay|in play|playing|1st half|2nd half|half time|halftime|extra time)\b/.test(raw) ||
    event.live === true || event.is_live === true || event.isLive === true
  ) {
    return { status: "inprogress", live: true };
  }
  return { status: raw || "upcoming", live: false };
}

function emptyOdds() {
  return {
    "1": null, X: null, "2": null,
    doubleChance: { "1X": null, X2: null, "12": null },
    over15: null, under15: null,
    over25: null, under25: null,
    over35: null, under35: null,
    bttsYes: null, bttsNo: null
  };
}

function validOdds(value) {
  const n = numberValue(value);
  return n !== null && n > 1 ? n : null;
}

function normalizeOddsFeed(rows) {
  const result = emptyOdds();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const market = textValue(row.market, row.market_name)
      .toLowerCase().replace(/[\s-]+/g, "_");
    const outcome = textValue(row.outcome, row.outcome_name)
      .toLowerCase().replace(/[\s-]+/g, "_");
    const price = validOdds(firstValue(
      row.decimal_odds, row.decimalOdds, row.odds, row.price
    ));
    if (price === null) continue;

    if (["1x2", "match_winner", "full_time_result", "winner"].includes(market)) {
      if (["home", "home_win", "1"].includes(outcome)) result["1"] = price;
      if (["draw", "tie", "x"].includes(outcome)) result.X = price;
      if (["away", "away_win", "2"].includes(outcome)) result["2"] = price;
    }

    if (market === "double_chance") {
      if (["1x", "home_or_draw"].includes(outcome)) result.doubleChance["1X"] = price;
      if (["x2", "draw_or_away"].includes(outcome)) result.doubleChance.X2 = price;
      if (["12", "home_or_away"].includes(outcome)) result.doubleChance["12"] = price;
    }

    for (const [line, names] of [
      ["15", ["over_under_15", "over_under_1_5", "totals_15"]],
      ["25", ["over_under_25", "over_under_2_5", "totals_25"]],
      ["35", ["over_under_35", "over_under_3_5", "totals_35"]]
    ]) {
      if (names.includes(market) && ["over", "under"].includes(outcome)) {
        result[`${outcome}${line}`] = price;
      }
    }

    if (["btts", "both_teams_to_score"].includes(market)) {
      if (["yes", "btts_yes"].includes(outcome)) result.bttsYes = price;
      if (["no", "btts_no"].includes(outcome)) result.bttsNo = price;
    }
  }
  return result;
}

function normalizeEmbeddedOdds(event) {
  const source = firstValue(event.odds, event.prices, event.markets, event.bets) || {};
  const result = Array.isArray(source) ? normalizeOddsFeed(source) : emptyOdds();
  const assign = (key, ...values) => {
    const price = validOdds(firstValue(...values));
    if (price !== null) result[key] = price;
  };

  assign("1", event.home_odds, event.homeOdds, event.odds_home,
    source.home, source.home_win, source.homeOdds, source["1"]);
  assign("X", event.draw_odds, event.drawOdds, event.odds_draw,
    source.draw, source.draw_odds, source.X, source.x);
  assign("2", event.away_odds, event.awayOdds, event.odds_away,
    source.away, source.away_win, source.awayOdds, source["2"]);

  for (const line of ["15", "25", "35"]) {
    for (const side of ["over", "under"]) {
      assign(`${side}${line}`,
        source[`${side}${line}`],
        source[`${side}_${line}_goals`],
        source[`${side}_${line[0]}_${line[1]}`]);
    }
  }
  assign("bttsYes", source.btts_yes, source.bttsYes);
  assign("bttsNo", source.btts_no, source.bttsNo);

  for (const key of ["1X", "X2", "12"]) {
    result.doubleChance[key] = validOdds(firstValue(
      source.doubleChance?.[key], source[key]
    ));
  }
  return result;
}

function normalizeEvent(event, index = 0) {
  event = event && typeof event === "object" ? event : {};
  const teams = event.teams || {};

  const home = normalizeTeam(firstValue(
    event.home, event.home_team, event.homeTeam,
    event.team_home, teams.home, event.localteam
  ));
  const away = normalizeTeam(firstValue(
    event.away, event.away_team, event.awayTeam,
    event.team_away, teams.away, event.visitorteam
  ));

  home.name = textValue(home.name, event.home_name,
    event.homeTeamName, event.home_team_name) || "Home";
  away.name = textValue(away.name, event.away_name,
    event.awayTeamName, event.away_team_name) || "Away";

  const providerId = firstValue(
    event.id, event.event_id, event.eventId,
    event.fixture_id, event.fixtureId,
    event.match_id, event.matchId, event.fixture?.id
  );

  const startTime = normalizeStartTime(firstValue(
    event.start_time, event.startTime, event.starts_at,
    event.start, event.date, event.datetime, event.kickoff,
    event.kickoff_time, event.scheduled_at,
    event.event_date, event.fixture?.date, event.timestamp
  ));

  const score = event.score || event.scores || {};
  return {
    id: String(providerId ?? `missing-${index}`),
    providerId: providerId === null ? null : String(providerId),
    league: textValue(
      event.league_name, event.competition_name, event.tournament_name,
      event.league?.name, event.competition?.name,
      event.league, event.competition, event.tournament
    ) || "Football",
    home,
    away,
    startTime,
    date: dateKey(startTime),
    ...normalizeStatus(event),
    score: {
      home: numberValue(firstValue(
        event.home_score, event.homeScore, score.home,
        score.localteam, score.home_score, event.goals?.home
      )),
      away: numberValue(firstValue(
        event.away_score, event.awayScore, score.away,
        score.visitorteam, score.away_score, event.goals?.away
      ))
    },
    odds: normalizeEmbeddedOdds(event)
  };
}

const feedCache = new Map();
const knownEvents = new Map();

async function getEvents(live = false) {
  const url = live ? BSD_LIVE_URL : BSD_API_URL;
  const cached = feedCache.get(url);
  const ttl = live ? 15000 : 60000;

  if (cached && Date.now() - cached.time < ttl) return cached.result;

  const { rows, truncated } = await fetchPages(url);
  const unique = new Map();

  rows.map(normalizeEvent).forEach(event => {
    unique.set(event.id, event);
    if (event.providerId !== null) knownEvents.set(event.id, event);
  });

  const result = { events: [...unique.values()], truncated };
  feedCache.set(url, { time: Date.now(), result });
  return result;
}

const oddsCache = new Map();

async function getEventOdds(eventId) {
  const cached = oddsCache.get(eventId);
  if (cached && Date.now() - cached.time < 30000) return cached.odds;

  const params = new URLSearchParams({ event_id: eventId, limit: "100" });
  const data = await fetchBSD(`${BSD_BASE_URL}/odds/?${params}`);
  const odds = normalizeOddsFeed(asArray(data));
  oddsCache.set(eventId, { time: Date.now(), odds });
  return odds;
}

function mergeOdds(base, extra) {
  const result = {
    ...base,
    doubleChance: { ...base.doubleChance }
  };
  for (const key of Object.keys(extra)) {
    if (key === "doubleChance") {
      for (const dc of ["1X", "X2", "12"]) {
        if (extra.doubleChance[dc] !== null) {
          result.doubleChance[dc] = extra.doubleChance[dc];
        }
      }
    } else if (extra[key] !== null) {
      result[key] = extra[key];
    }
  }
  return result;
}

function errorResponse(res, error, message) {
  console.error(message, error.message);
  return res.status(502).json({
    success: false,
    error: message,
    details: error.status ? `BSD HTTP ${error.status}` : "Request failed",
    events: []
  });
}

app.get("/api/events", async (req, res) => {
  const filter = String(req.query.filter || "today");
  if (!["all", "today", "tomorrow", "live"].includes(filter)) {
    return res.status(400).json({ success: false, error: "Invalid filter." });
  }

  try {
    const result = await getEvents(filter === "live");
    const today = dateKey(new Date());
    const tomorrow = tomorrowKey();

    let selected = result.events.filter(event => {
      if (filter === "today") return event.date === today;
      if (filter === "tomorrow") return event.date === tomorrow;
      if (filter === "live") return event.live;
      return true;
    });

    selected.sort((a, b) => (
      (a.startTime ? Date.parse(a.startTime) : Infinity) -
      (b.startTime ? Date.parse(b.startTime) : Infinity)
    ));

    const total = selected.length;
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    if (Number.isFinite(requestedLimit)) {
      selected = selected.slice(0, Math.min(Math.max(requestedLimit, 1), 100));
    }

    res.json({
      success: true,
      source: "BSD",
      filter,
      timeZone: TIME_ZONE,
      today,
      tomorrow,
      count: selected.length,
      total,
      totalReturnedByBSD: result.events.length,
      paginationTruncated: result.truncated,
      events: selected,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    errorResponse(res, error, "Could not load football events from BSD.");
  }
});

app.get("/api/live", async (req, res) => {
  try {
    const result = await getEvents(true);
    const events = result.events.filter(e => e.live);
    res.json({
      success: true, source: "BSD",
      count: events.length, events,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    errorResponse(res, error, "Could not load live events from BSD.");
  }
});

app.get("/api/events/:id/odds", async (req, res) => {
  try {
    const event = knownEvents.get(req.params.id);
    if (!event || !event.providerId) {
      return res.status(404).json({
        success: false, error: "Event not found. Refresh matches first."
      });
    }

    try {
      event.odds = mergeOdds(event.odds, await getEventOdds(event.id));
    } catch (error) {
      // Embedded odds ካሉ እነሱን ይጠቀማል።
      console.error("BSD ODDS ERROR:", error.message);
    }
    res.json({ success: true, odds: event.odds });
  } catch (error) {
    errorResponse(res, error, "Could not load odds.");
  }
});

app.get("/api/leagues", async (req, res) => {
  try {
    const { rows } = await fetchPages(BSD_LEAGUES_URL);
    const leagues = rows.map(item => ({
      id: firstValue(item?.id, item?.league_id, item?.competition_id),
      name: textValue(item?.name, item?.title,
        item?.league_name, item?.competition_name, item)
    })).filter(item => item.name);

    res.json({ success: true, source: "BSD", count: leagues.length, leagues });
  } catch (error) {
    errorResponse(res, error, "Could not load leagues from BSD.");
  }
});

// DEMO ONLY: የእውነተኛ ገንዘብ ዋሌት አይደለም።
// userId ማረጋገጫ አይደለም፤ restart ሲደረግ ውሂቡ ይጠፋል።
const demoWallets = new Map();

function getWallet(userId = "demo") {
  const id = String(userId || "demo");
  if (!demoWallets.has(id)) {
    demoWallets.set(id, {
      userId: id, balance: 1000, bonus: 0, bets: []
    });
  }
  return demoWallets.get(id);
}

app.get("/api/wallet", (req, res) => {
  const wallet = getWallet(req.query.userId);
  res.json({
    success: true,
    wallet: {
      userId: wallet.userId, balance: wallet.balance, bonus: wallet.bonus
    }
  });
});

const marketMap = {
  "1": ["result", "Home Win"],
  X: ["result", "Draw"],
  "2": ["result", "Away Win"],
  "1X": ["doubleChance", "1X"],
  X2: ["doubleChance", "X2"],
  "12": ["doubleChance", "12"],
  over15: ["total15", "Over 1.5"],
  under15: ["total15", "Under 1.5"],
  over25: ["total25", "Over 2.5"],
  under25: ["total25", "Under 2.5"],
  over35: ["total35", "Over 3.5"],
  under35: ["total35", "Under 3.5"],
  bttsYes: ["btts", "BTTS Yes"],
  bttsNo: ["btts", "BTTS No"]
};

function selectionPrice(odds, selection) {
  return ["1X", "X2", "12"].includes(selection)
    ? odds.doubleChance?.[selection]
    : odds[selection];
}

app.post("/api/bet", async (req, res) => {
  try {
    const {
      userId = "demo", betType = "single",
      selections = [], stake
    } = req.body || {};

    const amount = Number(stake);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      throw new Error("Invalid stake.");
    }
    if (!Array.isArray(selections) || !selections.length || selections.length > 20) {
      throw new Error("Select between 1 and 20 selections.");
    }
    if (!["single", "combo"].includes(betType)) {
      throw new Error("Invalid bet type.");
    }
    if (betType === "single" && selections.length !== 1) {
      throw new Error("Single requires exactly one selection.");
    }
    if (betType === "combo" && selections.length < 2) {
      throw new Error("Combo requires at least two selections.");
    }

    const seen = new Set();
    const cleanSelections = [];
    let combinedOdds = 1;

    for (const selection of selections) {
      if (!selection || typeof selection !== "object") {
        throw new Error("Invalid selection.");
      }
      const id = String(selection.eventId || "");
      const key = String(selection.selection || "");
      const event = knownEvents.get(id);

      if (!event || !event.providerId || !marketMap[key]) {
        throw new Error("Unknown event or market. Refresh matches.");
      }
      if (seen.has(id)) {
        throw new Error("Combo allows only one selection per match.");
      }
      seen.add(id);

      // Live betting ለዚህ demo አልተከፈተም።
      if (
        event.live || !event.startTime ||
        Date.parse(event.startTime) <= Date.now() ||
        ["finished", "postponed", "cancelled", "canceled", "abandoned", "suspended"]
          .includes(event.status)
      ) {
        throw new Error("This match is not open for pre-match betting.");
      }

      const price = validOdds(selectionPrice(event.odds, key));
      if (price === null) throw new Error("Odds are unavailable.");
      if (Number(selection.odds) !== price) {
        throw new Error("Odds changed. Refresh and select again.");
      }

      combinedOdds *= price;
      cleanSelections.push({
        eventId: id,
        match: `${event.home.name} vs ${event.away.name}`,
        market: marketMap[key][0],
        label: marketMap[key][1],
        selection: key,
        odds: price
      });
    }

    const potentialWin = amount * combinedOdds;
    if (!Number.isFinite(combinedOdds) || !Number.isFinite(potentialWin)) {
      throw new Error("Combined odds are too large.");
    }

    const wallet = getWallet(userId);
    if (wallet.balance < amount) throw new Error("Insufficient balance.");

    const bet = {
      id: `BET-${randomUUID()}`,
      userId: wallet.userId,
      betType,
      stake: amount,
      combinedOdds,
      potentialWin: Math.round(potentialWin * 100) / 100,
      status: "PENDING",
      selections: cleanSelections,
      createdAt: new Date().toISOString()
    };

    wallet.balance = Math.round((wallet.balance - amount) * 100) / 100;
    wallet.bets.unshift(bet);

    res.json({
      success: true,
      message: "Demo bet placed successfully.",
      bet,
      wallet: { balance: wallet.balance, bonus: wallet.bonus }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get("/api/bets", (req, res) => {
  res.json({ success: true, bets: getWallet(req.query.userId).bets });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "football-betting",
    time: new Date().toISOString(),
    timeZone: TIME_ZONE,
    today: dateKey(new Date()),
    bsdConfigured: Boolean(BSD_API_KEY)
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "betting.html"));
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found." });
});

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);
  res.status(500).json({ success: false, error: "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Betting server running on port ${PORT}`);
  console.log(`BSD configured: ${Boolean(BSD_API_KEY)}`);
  console.log(`Time zone: ${TIME_ZONE}`);
});
