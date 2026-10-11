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
  return Number.isInteger(n) && n >= min && n <= max
    ? n
    : fallback;
}

const BSD_MAX_PAGES = integerSetting(
  process.env.BSD_MAX_PAGES, 10, 1, 200
);
const BSD_TIMEOUT_MS = integerSetting(
  process.env.BSD_TIMEOUT_MS, 15000, 1000, 60000
);

const BSD_DEBUG = process.env.BSD_DEBUG === "true";

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

function firstValue(...values) {
  return values.find(
    v => v !== undefined && v !== null && v !== ""
  ) ?? null;
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
        if (
          typeof nested === "string" ||
          typeof nested === "number"
        ) {
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
      text = text.replace(
        /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/,
        "$1T$2"
      );

      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        text += "T00:00:00+03:00";
      } else if (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)
      ) {
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
  const containers = [
    data,
    data?.data,
    data?.response
  ];

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
        responseKeys:
          data && typeof data === "object" && !Array.isArray(data)
            ? Object.keys(data)
            : [],
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

  if (
    !truncated &&
    reportedCount !== null &&
    reportedCount > rows.length
  ) {
    truncated = true;
    truncationReason = "reported_count_exceeds_fetched_rows";
  }

  return {
    rows,
    truncated,
    truncationReason,
    pagesFetched,
    reportedCount
  };
}

function normalizeTeam(team) {
  if (typeof team === "string") {
    return { id: null, name: team, logo: "" };
  }
  if (!team || typeof team !== "object") {
    return { id: null, name: "", logo: "" };
  }

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
    event.live === true ||
    event.is_live === true ||
    event.isLive === true
  ) {
    return { status: "inprogress", live: true };
  }

  return { status: raw || "upcoming", live: false };
}

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

  assign("1",
    event.home_odds, event.homeOdds, event.odds_home,
    source.home, source.home_win, source.homeOdds, source["1"]
  );
  assign("X",
    event.draw_odds, event.drawOdds, event.odds_draw,
    source.draw, source.draw_odds, source.X, source.x
  );
  assign("2",
    event.away_odds, event.awayOdds, event.odds_away,
    source.away, source.away_win, source.awayOdds, source["2"]
  );

  for (const line of ["15", "25", "35"]) {
    for (const side of ["over", "under"]) {
      assign(`${side}${line}`,
        source[`${side}${line}`],
        source[`${side}_${line}_goals`],
        source[`${side}_${line[0]}_${line[1]}`]
      );
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

  home.name = textValue(
    home.name, event.home_name, event.homeTeamName, event.home_team_name
  ) || "Home";
  away.name = textValue(
    away.name, event.away_name, event.awayTeamName, event.away_team_name
  ) || "Away";

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
      urlObj.set("date", tomKey);
    }
  }
  const url = urlObj.href;

  const cached = feedCache.get(url);
  const ttl = live ? 15000 : 60000;

  if (cached && Date.now() - cached.time < ttl) return cached.result;
  if (feedPending.has(url)) return feedPending.get(url);

  const pending = (async () => {
    const pageResult = await fetchPages(url);
    const normalized = pageResult.rows.map(
      (row, index) => normalizeEvent(row, index)
    );

    const unique = new Map();

    for (const event of normalized) {
      unique.set(event.id, event);
      if (event.providerId !== null) knownEvents.set(event.id, event);
    }

    const events = [...unique.values()];
    const today = todayKey;
    const tomorrow = tomKey;
    const dateCounts = {};

    for (const event of events) {
      const key = event.date || "INVALID_OR_MISSING_DATE";
      dateCounts[key] = (dateCounts[key] || 0) + 1;
    }

    const diagnostics = {
      rawRows: pageResult.rows.length,
      uniqueEvents: events.length,
      pagesFetched: pageResult.pagesFetched,
      reportedCount: pageResult.reportedCount,
      missingStartTime: events.filter(e => !e.startTime).length,
      missingProviderId: events.filter(e => e.providerId === null).length,
      todayMatches: events.filter(e => e.date === today).length,
      tomorrowMatches: events.filter(e => e.date === tomorrow).length,
      dateCounts
    };

    console.log("BSD NORMALIZATION:", JSON.stringify({
      feed: live ? "live" : "events",
      today,
      tomorrow,
      paginationTruncated: pageResult.truncated,
      truncationReason: pageResult.truncationReason,
      ...diagnostics,
      normalizedSamples: events.slice(0, 2).map(e => ({
        id: e.id,
        home: e.home.name,
        away: e.away.name,
        startTime: e.startTime,
        date: e.date,
        status: e.status
      }))
    }, null, 2));

    const result = {
      events,
      truncated: pageResult.truncated,
      truncationReason: pageResult.truncationReason,
      rawRows: pageResult.rows.length,
      diagnostics
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

async function getEventOdds(eventId) {
  const id = String(eventId);
  const cached = oddsCache.get(id);
  if (cached && Date.now() - cached.time < 30000) return cached.odds;
  if (oddsPending.has(id)) return oddsPending.get(id);

  const pending = (async () => {
    const params = new URLSearchParams({ event_id: id, limit: "100" });
    const data = await fetchBSD(`${BSD_BASE_URL}/odds/?${params}`);
    const odds = normalizeOddsFeed(asArray(data));
    oddsCache.set(id, { time: Date.now(), odds });
    return odds;
  })();

  oddsPending.set(id, pending);

  try {
    return await pending;
  } finally {
    oddsPending.delete(id);
  }
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

function eventSortTime(event) {
  return event.startTime ? Date.parse(event.startTime) : Infinity;
}

app.get("/api/events", async (req, res) => {
  const filter = String(req.query.filter || "today");

  if (!["all", "today", "tomorrow", "live"].includes(filter)) {
    return res.status(400).json({
      success: false, error: "Invalid filter."
    });
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

    selected.sort((a, b) => {
      const first = eventSortTime(a);
      const second = eventSortTime(b);
      return first === second ? 0 : first - second;
    });

    const total = selected.length;
    const requestedLimit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(requestedLimit)) {
      selected = selected.slice(
        0, Math.min(Math.max(requestedLimit, 1), 100)
      );
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
      totalReturnedByBSD: result.rawRows,
      totalNormalizedEvents: result.events.length,
      paginationTruncated: result.truncated,
      paginationTruncationReason: result.truncationReason,
      diagnostics: req.query.debug === "1"
        ? result.diagnostics
        : undefined,
      events: selected,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    errorResponse(res, error, "Could not load football events from BSD.");
  }
});

app.get("/api/live", async (req, res) => {
  try {
    const result = await getEvents("live", true);
    const events = result.events.filter(e => e.live);

    res.json({
      success: true,
      source: "BSD",
      count: events.length,
      paginationTruncated: result.truncated,
      paginationTruncationReason: result.truncationReason,
      events,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    errorResponse(res, error, "Could not load live events from BSD.");
  }
});

app.get("/api/events/:id/odds", async (req, res) => {
  try {
    const event = knownEvents.get(req.params.id);

    if (!event || event.providerId === null) {
      return res.status(404).json({
        success: false,
        error: "Event not found. Refresh matches first."
      });
    }

    try {
      event.odds = mergeOdds(
        event.odds,
        await getEventOdds(event.providerId)
      );
    } catch (error) {
      console.error("BSD ODDS ERROR:", error.message);
    }

    res.json({ success: true, odds: event.odds });
  } catch (error) {
    errorResponse(res, error, "Could not load odds.");
  }
});

app.get("/api/leagues", async (req, res) => {
  try {
    const result = await fetchPages(BSD_LEAGUES_URL);

    const leagues = result.rows.map(item => ({
      id: firstValue(item?.id, item?.league_id, item?.competition_id),
      name: textValue(
        item?.name, item?.title,
        item?.league_name, item?.competition_name, item
      )
    })).filter(item => item.name);

    res.json({
      success: true,
      source: "BSD",
      count: leagues.length,
      paginationTruncated: result.truncated,
      paginationTruncationReason: result.truncationReason,
      leagues
    });
  } catch (error) {
    errorResponse(res, error, "Could not load leagues from BSD.");
  }
});

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

app.get("/api/wallet", (req, res) => {
  const wallet = getWallet(req.query.userId);

  res.json({
    success: true,
    wallet: {
      userId: wallet.userId,
      balance: wallet.balance,
      bonus: wallet.bonus
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
      userId = "demo",
      betType = "single",
      selections = [],
      stake
    } = req.body || {};

    if (typeof stake !== "number" && typeof stake !== "string") {
      throw new Error("Invalid stake.");
    }

    const amount = Number(stake);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 1000000 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001
    ) {
      throw new Error("Invalid stake. Use at most two decimal places.");
    }

    if (
      !Array.isArray(selections) ||
      !selections.length ||
      selections.length > 20
    ) {
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

      const id = String(selection.eventId ?? "");
      const key = String(selection.selection ?? "");
      const event = knownEvents.get(id);

      if (
        !event ||
        event.providerId === null ||
        !Object.prototype.hasOwnProperty.call(marketMap, key)
      ) {
        throw new Error("Unknown event or market. Refresh matches.");
      }

      if (seen.has(id)) {
        throw new Error("Combo allows only one selection per match.");
      }
      seen.add(id);

      const startsAt = event.startTime
        ? Date.parse(event.startTime)
        : NaN;

      if (
        event.live ||
        !Number.isFinite(startsAt) ||
        startsAt <= Date.now() ||
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
      wallet: {
        balance: wallet.balance,
        bonus: wallet.bonus
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/bets", (req, res) => {
  res.json({
    success: true,
    bets: getWallet(req.query.userId).bets
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "football-betting",
    time: new Date().toISOString(),
    timeZone: TIME_ZONE,
    today: dateKey(new Date()),
    bsdConfigured: Boolean(BSD_API_KEY),
    maxPages: BSD_MAX_PAGES,
    debugEnabled: BSD_DEBUG
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "betting.html"));
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found."
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  console.error("SERVER ERROR:", err.message);

  const status =
    err.type === "entity.too.large" ? 413 :
    err.type === "entity.parse.failed" ? 400 : 500;

  res.status(status).json({
    success: false,
    error:
      status === 413 ? "Request body is too large." :
      status === 400 ? "Invalid JSON body." :
      "Internal server error."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Betting server running on port ${PORT}`);
  console.log(`BSD configured: ${Boolean(BSD_API_KEY)}`);
  console.log(`Time zone: ${TIME_ZONE}`);
  console.log(`BSD max pages: ${BSD_MAX_PAGES}`);
  console.log(`BSD debug enabled: ${BSD_DEBUG}`);
});
