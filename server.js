"use strict";

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

const BSD_API_URL =
  process.env.BSD_API_URL || `${BSD_BASE_URL}/events/`;
const BSD_LIVE_URL =
  process.env.BSD_LIVE_URL || `${BSD_BASE_URL}/events/live/`;
const BSD_LEAGUES_URL =
  process.env.BSD_LEAGUES_URL || `${BSD_BASE_URL}/leagues/`;

function integerSetting(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const BSD_MAX_PAGES = integerSetting(process.env.BSD_MAX_PAGES, 10, 1, 200);
const BSD_TIMEOUT_MS = integerSetting(process.env.BSD_TIMEOUT_MS, 15000, 1000, 60000);
const BSD_DEBUG = process.env.BSD_DEBUG === "true";

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

function firstValue(...values) {
  return values.find(v => v !== undefined && v !== null && v !== "") ?? null;
}

function numberValue(value, fallback = null) {
  if (
    value === undefined || value === null || value === "" ||
    typeof value === "object" || typeof value === "boolean"
  ) {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function textValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;

    if (typeof value === "object") {
      for (const key of [
        "name", "title", "label", "short_name",
        "shortName", "display_name"
      ]) {
        const nested = value[key];
        if (typeof nested === "string" || typeof nested === "number") {
          const text = String(nested).trim();
          if (text) return text;
        }
      }
      continue;
    }

    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function asArray(data, depth = 0) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object" || depth > 4) return [];

  const keys = [
    "results", "data", "events", "fixtures", "matches",
    "items", "response", "leagues", "odds"
  ];

  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }

  for (const key of keys) {
    if (data[key] && typeof data[key] === "object") {
      const rows = asArray(data[key], depth + 1);
      if (rows.length) return rows;
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
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;

  const parts = Object.fromEntries(
    dateFormatter.formatToParts(d).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function tomorrowKey(today = dateKey(new Date())) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function normalizeStartTime(value) {
  if (value === undefined || value === null || value === "") return null;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (typeof value !== "string" && typeof value !== "number") return null;

  let date;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    date = new Date(Math.abs(value) < 1e12 ? value * 1000 : value);
  } else {
    let text = value.trim();
    if (!text) return null;

    if (/^\d{10}(?:\.\d+)?$/.test(text)) {       date = new Date(Number(text) * 1000);     } else if (/^\d{13}$/.test(text)) {
      date = new Date(Number(text));
    } else {
      text = text.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");

      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        text += "T00:00:00+03:00";
      } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) {
        text += "Z";
      } else if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
      ) {
        return null;
      }

      date = new Date(text);
    }
  }

  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function fetchBSD(url) {
  if (!BSD_API_KEY) throw new Error("BSD_API_KEY is not configured");

  const response = await fetch(url, {
    headers: {
      Authorization: `Token ${BSD_API_KEY}`,
      Accept: "application/json"
    },
    redirect: "manual",
    signal: AbortSignal.timeout(BSD_TIMEOUT_MS)
  });

  if (!response.ok) {
    const error = new Error(`BSD HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function nextPageValue(data) {
  const containers = [data, data?.data, data?.response];

  for (const container of containers) {
    const next = firstValue(
      container?.next,
      container?.pagination?.next,
      container?.links?.next
    );

    if (typeof next === "string" && next.trim()) return next.trim();

    if (next && typeof next === "object") {
      const href = firstValue(next.href, next.url);
      if (typeof href === "string" && href.trim()) return href.trim();
    }
  }
  return null;
}

async function fetchPages(initialUrl) {
  const initial = new URL(initialUrl);
  const allowedOrigin = initial.origin;
  const visited = new Set();
  const rows = [];

  let url = initial.href;
  let pagesFetched = 0;
  let truncated = false;
  let truncationReason = null;
  let reportedCount = null;

  while (url) {
    if (pagesFetched >= BSD_MAX_PAGES) {
      truncated = true;
      truncationReason = "page_limit";
      break;
    }

    if (visited.has(url)) {
      truncated = true;
      truncationReason = "pagination_cycle";
      break;
    }

    visited.add(url);

    const data = await fetchBSD(url);
    const pageRows = asArray(data);

    if (pagesFetched === 0) {
      reportedCount = numberValue(firstValue(
        data?.count,
        data?.pagination?.count,
        data?.data?.count,
        data?.response?.count
      ));

      console.log("BSD FIRST PAGE:", JSON.stringify({
        responseKeys: data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [],
        count: reportedCount,
        hasNext: Boolean(nextPageValue(data)),
        returnedRows: pageRows.length,
        sampleEvents: BSD_DEBUG ? pageRows.slice(0, 2) : undefined
      }, null, 2));
    }

    rows.push(...pageRows);
    pagesFetched++;

    const next = nextPageValue(data);
    if (!next) {
      url = null;
      break;
    }

    const resolved = new URL(next, url);

    if (
      resolved.origin !== allowedOrigin ||
      resolved.username ||
      resolved.password
    ) {
      throw new Error("Unexpected pagination URL");
    }

    resolved.hash = "";
    url = resolved.href;
  }

  if (!truncated && reportedCount !== null && reportedCount > rows.length) {
    truncated = true;
    truncationReason = "reported_count_exceeds_fetched_rows";
  }

  return { rows, truncated, truncationReason, pagesFetched, reportedCount };
}

function normalizeTeam(team) {
  if (typeof team === "string") return { id: null, name: team, logo: "" };
  if (!team || typeof team !== "object") return { id: null, name: "", logo: "" };

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

  for (const [pattern, status] of [
    [/\bpostponed\b/, "postponed"],
    [/\b(cancelled|canceled)\b/, "cancelled"],
    [/\babandoned\b/, "abandoned"],
    [/\bsuspended\b/, "suspended"]
  ]) {
    if (pattern.test(raw)) return { status, live: false };
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
    "1": 1.95, X: 3.20, "2": 3.80, // Default fallback odds (ባዶ በሚሆንበት ጊዜ የሚተካ)
    doubleChance: { "1X": 1.25, X2: 1.75, "12": 1.30 },
    over15: 1.35, under15: 2.90,
    over25: 1.90, under25: 1.85,
    over35: 3.10, under35: 1.30,
    bttsYes: 1.80, bttsNo: 1.90
  };
}

function validOdds(value) {
  const n = numberValue(value);
  return n !== null && n > 1 ? n : null;
}

function firstValidOdds(...values) {
  for (const value of values) {
    const price = validOdds(value);
    if (price !== null) return price;
  }
  return null;
}

function normalizeOddsFeed(rows) {
  const result = emptyOdds();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const market = textValue(row.market, row.market_name)
      .toLowerCase().replace(/[\s-]+/g, "_");
    const outcome = textValue(row.outcome, row.outcome_name)
      .toLowerCase().replace(/[\s-]+/g, "_");

    const price = firstValidOdds(
      row.decimal_odds, row.decimalOdds, row.odds, row.price
    );
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
  const source = firstValue(
    event.odds, event.prices, event.markets, event.bets
  ) || {};

  const result = Array.isArray(source)
    ? normalizeOddsFeed(source)
    : emptyOdds();

  const assign = (key, ...values) => {
    const price = firstValidOdds(...values);
    if (price !== null) result[key] = price;
  };

  assign("1", event.home_odds, event.homeOdds, event.odds_home, source.home, source.home_win, source.homeOdds, source["1"]);
  assign("X", event.draw_odds, event.drawOdds, event.odds_draw, source.draw, source.draw_odds, source.X, source.x);
  assign("2", event.away_odds, event.awayOdds, event.odds_away, source.away, source.away_win, source.awayOdds, source["2"]);

  for (const line of ["15", "25", "35"]) {
    for (const side of ["over", "under"]) {
      assign(`${side}${line}`, source[`${side}${line}`], source[`${side}_${line}_goals`], source[`${side}_${line[0]}_${line[1]}`]);
    }
  }

  assign("bttsYes", source.btts_yes, source.bttsYes);
  assign("bttsNo", source.btts_no, source.bttsNo);

  for (const key of ["1X", "X2", "12"]) {
    const price = firstValidOdds(source.doubleChance?.[key], source[key]);
    if (price !== null) result.doubleChance[key] = price;
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

  home.name = textValue(home.name, event.home_name, event.homeTeamName, event.home_team_name) || "Home";
  away.name = textValue(away.name, event.away_name, event.awayTeamName, event.away_team_name) || "Away";

  const providerId = firstValue(
    event.id, event.event_id, event.eventId,
    event.fixture_id, event.fixtureId,
    event.match_id, event.matchId, event.fixture?.id
  );

  const startCandidates = [
    event.start_time, event.startTime, event.starts_at,
    event.start, event.date, event.datetime, event.kickoff,
    event.kickoff_time, event.scheduled_at,
    event.event_date, event.fixture?.date, event.timestamp
  ];

  let startTime = null;
  for (const candidate of startCandidates) {
    const parsed = normalizeStartTime(candidate);
    if (parsed !== null) {
      startTime = parsed;
      break;
    }
  }

  const score = event.score || event.scores || {};

  return {
    id: String(providerId ?? `missing-${index}`),
    providerId: providerId == null ? null : String(providerId),
    league: textValue(
      event.league_name, event.competition_name, event.tournament_name,
      event.league?.name, event.competition?.name,
      event.league, event.competition, event.tournament
    ) || "Premier League", // ነባሪ ሊግ
    home,
    away,
    startTime,
    date: dateKey(startTime),
    ...normalizeStatus(event),
    score: {
      home: numberValue(firstValue(event.home_score, event.homeScore, score.home, score.localteam, score.home_score, event.goals?.home)),
      away: numberValue(firstValue(event.away_score, event.awayScore, score.away, score.visitorteam, score.away_score, event.goals?.away))
    },
    odds: normalizeEmbeddedOdds(event)
  };
}

const feedCache = new Map();
const feedPending = new Map();
const knownEvents = new Map();
const oddsCache = new Map();
const oddsPending = new Map();

async function getEvents(filter = "today", live = false) {
  const baseUrl = live ? BSD_LIVE_URL : BSD_API_URL;
  const todayKey = dateKey(new Date());
  const tomKey = tomorrowKey(todayKey);

  const urlObj = new URL(baseUrl);
  if (!live) {
    if (filter === "today") {
      urlObj.searchParams.set("date", todayKey);
    } else if (filter === "tomorrow") {
      urlObj.searchParams.set("date", tomKey);
    }
  }
  const url = urlObj.href;

  const cached = feedCache.get(url);
  const ttl = live ? 15000 : 60000;

  if (cached && Date.now() - cached.time < ttl) return cached.result;
  if (feedPending.has(url)) return feedPending.get(url);

  const pending = (async () => {
    const pageResult = await fetchPages(url);
    const normalized = pageResult.rows.map((row, index) => normalizeEvent(row, index));

    const unique = new Map();
    for (const event of normalized) {
      unique.set(event.id, event);
      if (event.providerId !== null) knownEvents.set(event.id, event);
    }

    const events = [...unique.values()];
    const result = {
      events,
      truncated: pageResult.truncated,
      truncationReason: pageResult.truncationReason,
      rawRows: pageResult.rows.length
    };

    feedCache.set(url, { time: Date.now(), result });
    return result;
  })();

  feedPending.set(url, pending);

  try {
    return await pending;
  } finally {
    feedPending.delete(url);
  }
}

// ---------------- API ENDPOINTS ----------------

app.get("/api/events", async (req, res) => {
  const filter = String(req.query.filter || "today");
  const selectedLeague = req.query.league ? String(req.query.league).trim() : null;

  if (!["all", "today", "tomorrow", "live"].includes(filter)) {
    return res.status(400).json({ success: false, error: "Invalid filter." });
  }

  try {
    const result = await getEvents(filter, filter === "live");
    const today = dateKey(new Date());
    const tomorrow = tomorrowKey(today);

    let selected = result.events.filter(event => {
      if (filter === "today") return event.date === today;
      if (filter === "tomorrow") return event.date === tomorrow;
      if (filter === "live") return event.live;
      return true;
    });

    // ያሉትን ሊጎች ለይቶ ማውጫ (Available Leagues for selection)
    const availableLeagues = [...new Set(selected.map(e => e.league))].filter(Boolean);

    // ተጠቃሚው መርጦ ከሆነ በሊግ ማጣራት
    if (selectedLeague) {
      selected = selected.filter(e => e.league.toLowerCase() === selectedLeague.toLowerCase());
    }

    selected.sort((a, b) => (a.startTime ? Date.parse(a.startTime) : Infinity) - (b.startTime ? Date.parse(b.startTime) : Infinity));

    res.json({
      success: true,
      source: "BSD",
      filter,
      selectedLeague,
      availableLeagues, // ብራውዘሩ ለተጠቃሚው ማሳየት የሚችላቸው የሊግ ስሞች
      timeZone: TIME_ZONE,
      today,
      tomorrow,
      count: selected.length,
      events: selected,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("ERROR:", error.message);
    res.status(502).json({ success: false, error: "Could not load football events." });
  }
});

app.get("/api/wallet", (req, res) => {
  res.json({ success: true, wallet: { userId: "demo", balance: 1000, bonus: 0 } });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, server: "football-betting", time: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "betting.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Betting server running on port ${PORT}`);
});
