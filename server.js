"use strict";

const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const TIMEZONE = "Africa/Addis_Ababa";

// Override this with your documented BSD events endpoint if necessary.
const EVENTS_URL =
  process.env.BSD_API_URL ||
  "https://sports.bzzoiro.com/api/v2/events/";

const API_KEY = process.env.BSD_API_KEY;
const MAX_PAGES = Math.min(
  50,
  Math.max(1, Number(process.env.BSD_MAX_PAGES) || 10)
);

const cache = new Map();
const pending = new Map();
const accounts = new Map();

const MARKETS = {
  home: { group: "Match result", label: "Home", fallback: 1.95 },
  draw: { group: "Match result", label: "Draw", fallback: 3.2 },
  away: { group: "Match result", label: "Away", fallback: 3.8 },

  over15: { group: "Goals · 1.5", label: "Over 1.5", fallback: 1.35 },
  under15: { group: "Goals · 1.5", label: "Under 1.5", fallback: 2.9 },
  over25: { group: "Goals · 2.5", label: "Over 2.5", fallback: 1.9 },
  under25: { group: "Goals · 2.5", label: "Under 2.5", fallback: 1.85 },
  over35: { group: "Goals · 3.5", label: "Over 3.5", fallback: 3.1 },
  under35: { group: "Goals · 3.5", label: "Under 3.5", fallback: 1.3 },

  cornersOver85: {
    group: "Corners · 8.5", label: "Over 8.5", fallback: 1.65
  },
  cornersUnder85: {
    group: "Corners · 8.5", label: "Under 8.5", fallback: 2.15
  },
  cornersOver95: {
    group: "Corners · 9.5", label: "Over 9.5", fallback: 1.9
  },
  cornersUnder95: {
    group: "Corners · 9.5", label: "Under 9.5", fallback: 1.85
  },
  cornersOver105: {
    group: "Corners · 10.5", label: "Over 10.5", fallback: 2.25
  },
  cornersUnder105: {
    group: "Corners · 10.5", label: "Under 10.5", fallback: 1.6
  },

  bttsYes: { group: "BTTS", label: "Yes", fallback: 1.8 },
  bttsNo: { group: "BTTS", label: "No", fallback: 1.9 },

  "1X": { group: "Double chance", label: "1X", fallback: 1.25 },
  X2: { group: "Double chance", label: "X2", fallback: 1.75 },
  "12": { group: "Double chance", label: "12", fallback: 1.3 }
};

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function first(...values) {
  return values.find(v => v !== undefined && v !== null && v !== "");
}

function name(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const result = name(value.name, value.title, value.label);
      if (result) return result;
    }
  }
  return "";
}

function number(value) {
  if (
    !["number", "string"].includes(typeof value) ||
    String(value).trim() === ""
  ) return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function decimal(value) {
  const n = number(value);
  return n !== null && n > 1 && n <= 10000 ? n : null;
}

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function dateKey(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function parseStart(value) {
  if (
    typeof value === "number" ||
    (typeof value === "string" && /^\d{10}(?:\.\d+)?$|^\d{13}$/.test(value))
  ) {
    const n = Number(value);
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  if (typeof value !== "string") return null;

  let input = value.trim().replace(
    /^(\d{4}-\d{2}-\d{2})\s+/,
    "$1T"
  );

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    input += "T00:00:00+03:00";
  } else if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(input)
  ) {
    // Set this environment variable only according to provider documentation.
    input += process.env.BSD_NAIVE_TIME_OFFSET || "Z";
  }

  if (!/^\d{4}-\d{2}-\d{2}T/.test(input)) return null;

  const date = new Date(input);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function rows(data, depth = 0) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object" || depth > 5) return [];

  for (const key of [
    "results", "data", "events", "matches", "fixtures", "items", "response"
  ]) {
    if (Array.isArray(data[key])) return data[key];
    const nested = rows(data[key], depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

function token(value) {
  return name(value).toLowerCase().replace(/[\s.-]+/g, "_");
}

function normalizeOdds(raw) {
  const output = {};
  const source = first(raw.odds, raw.prices, raw.markets, raw.bets) || {};

  function put(key, ...values) {
    if (!Object.hasOwn(MARKETS, key)) return;

    for (const value of values) {
      const amount = decimal(
        value && typeof value === "object"
          ? first(value.value, value.price, value.decimal_odds)
          : value
      );
      if (amount !== null) {
        output[key] = { value: amount, source: "provider" };
        return;
      }
    }
  }

  if (!Array.isArray(source)) {
    for (const key of Object.keys(MARKETS)) put(key, source[key]);

    put("home", source["1"], source.home, raw.home_odds, raw.odds_home);
    put("draw", source.X, source.draw, raw.draw_odds, raw.odds_draw);
    put("away", source["2"], source.away, raw.away_odds, raw.odds_away);

    put("bttsYes", source.btts_yes, source.btts?.yes);
    put("bttsNo", source.btts_no, source.btts?.no);

    for (const key of ["1X", "X2", "12"]) {
      put(key, source.double_chance?.[key], source.doubleChance?.[key]);
    }

    for (const line of ["15", "25", "35"]) {
      for (const side of ["over", "under"]) {
        put(
          `${side}${line}`,
          source[`${side}_${line}`],
          source[`${side}_${line[0]}_${line[1]}`]
        );
      }
    }

    for (const line of ["85", "95", "105"]) {
      put(`cornersOver${line}`, source[`corners_over_${line}`]);
      put(`cornersUnder${line}`, source[`corners_under_${line}`]);
    }
  }

  // Handles common arrays of markets containing outcome/selection objects.
  // Extend these aliases when your BSD payload uses different field names.
  function walk(value, context = {}, depth = 0) {
    if (!value || typeof value !== "object" || depth > 7) return;

    if (Array.isArray(value)) {
      value.forEach(item => walk(item, context, depth + 1));
      return;
    }

    const market = token(first(
      value.market_name,
      value.market,
      context.market,
      value.name
    ));
    const outcome = token(first(
      value.outcome_name, value.outcome, value.selection, value.name
    ));
    const line = number(first(value.line, value.total, context.line));
    const price = first(
      value.decimal_odds, value.decimalOdds, value.price,
      typeof value.odds !== "object" ? value.odds : undefined
    );

    let key;

    if (["1x2", "match_result", "full_time_result", "match_winner"].includes(market)) {
      key = {
        "1": "home", home: "home", home_win: "home",
        x: "draw", draw: "draw",
        "2": "away", away: "away", away_win: "away"
      }[outcome];
    } else if (market === "double_chance") {
      key = {
        "1x": "1X", home_or_draw: "1X",
        x2: "X2", draw_or_away: "X2",
        "12": "12", home_or_away: "12"
      }[outcome];
    } else if (["btts", "both_teams_to_score"].includes(market)) {
      key = { yes: "bttsYes", no: "bttsNo" }[outcome];
    } else {
      const corners = market.includes("corner");
      const allowed = corners ? [8.5, 9.5, 10.5] : [1.5, 2.5, 3.5];

      for (const total of allowed) {
        const suffix = String(total).replace(".", "");
        const separated = String(total).replace(".", "_");
        const generic = corners
          ? ["corners", "total_corners", "corners_over_under"]
          : ["totals", "total_goals", "over_under"];

        const aliases = corners
          ? [`corners_${suffix}`, `corners_${separated}`,
             `corners_over_under_${suffix}`, `corners_over_under_${separated}`]
          : [`over_under_${suffix}`, `over_under_${separated}`,
             `total_goals_${suffix}`, `total_goals_${separated}`];

        if (
          (generic.includes(market) && line === total) ||
          aliases.includes(market)
        ) {
          if (["over", "under"].includes(outcome)) {
            key = corners
              ? `corners${outcome === "over" ? "Over" : "Under"}${suffix}`
              : `${outcome}${suffix}`;
          }
        }
      }
    }

    if (key) put(key, price);

    for (const child of ["outcomes", "selections", "markets", "bets", "odds"]) {
      if (value[child] && typeof value[child] === "object") {
        walk(value[child], { market, line }, depth + 1);
      }
    }
  }

  walk(source);

  for (const [key, market] of Object.entries(MARKETS)) {
    if (!output[key]) {
      output[key] = { value: market.fallback, source: "demo" };
    }
  }

  return output;
}

function normalizeEvent(raw) {
  const id = first(raw.id, raw.event_id, raw.eventId, raw.fixture?.id);
  if (!["number", "string"].includes(typeof id)) return null;

  const home = name(
    raw.home, raw.home_team, raw.homeTeam, raw.teams?.home,
    raw.home_name, raw.home_team_name
  );
  const away = name(
    raw.away, raw.away_team, raw.awayTeam, raw.teams?.away,
    raw.away_name, raw.away_team_name
  );

  const startTime = [
    raw.start_time, raw.startTime, raw.kickoff, raw.kickoff_time,
    raw.starts_at, raw.datetime, raw.fixture?.date,
    raw.timestamp, raw.event_date, raw.date
  ].map(parseStart).find(Boolean);

  if (!home || !away || !startTime) return null;

  const status = token(first(raw.status, raw.state, raw.match_status));
  const closed = /^(finished|completed|complete|ft|ended|full_time|cancelled|canceled|postponed|abandoned|suspended)$/.test(status);

  const live = !closed && (
    raw.live === true ||
    raw.is_live === true ||
    raw.isLive === true ||
    /^(live|in_progress|inplay|in_play|playing|1st_half|2nd_half|half_time|halftime|extra_time)$/.test(status)
  );

  return {
    id: String(id),
    home,
    away,
    startTime,
    date: dateKey(startTime),
    league: name(
      raw.league_name, raw.competition_name,
      raw.league, raw.competition, raw.tournament
    ) || "Unspecified competition",
    live,
    status: closed ? "closed" : live ? "live" : "upcoming",
    bettable: !closed && (live || Date.parse(startTime) > Date.now()),
    score: {
      home: number(first(raw.home_score, raw.score?.home, raw.goals?.home)),
      away: number(first(raw.away_score, raw.score?.away, raw.goals?.away))
    },
    odds: normalizeOdds(raw)
  };
}

async function fetchDate(date) {
  if (!API_KEY) throw error(503, "BSD_API_KEY is not configured.");

  const initial = new URL(EVENTS_URL);
  // Confirm this parameter against your BSD documentation.
  initial.searchParams.set("date", date);

  let url = initial.href;
  const seen = new Set();
  const allRows = [];
  let pages = 0;
  let reason = null;

  while (url) {
    if (pages >= MAX_PAGES) {
      reason = "page_limit";
      break;
    }
    if (seen.has(url)) {
      reason = "pagination_cycle";
      break;
    }
    seen.add(url);

    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${API_KEY}`,
        Accept: "application/json"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) {
      throw error(502, `BSD returned HTTP ${response.status}.`);
    }

    const data = await response.json();
    allRows.push(...rows(data));
    pages++;

    const next = first(
      data.next, data.pagination?.next, data.links?.next,
      data.data?.next
    );
    const link = typeof next === "string"
      ? next
      : first(next?.href, next?.url);

    if (!link) {
      url = null;
      break;
    }

    const target = new URL(link, url);
    if (
      target.origin !== initial.origin ||
      target.pathname !== initial.pathname ||
      target.username || target.password
    ) {
      throw error(502, "Unsafe BSD pagination link.");
    }

    target.searchParams.set("date", date);
    target.hash = "";
    url = target.href;
  }

  const unique = new Map();
  let invalidRows = 0;
  let wrongDateRows = 0;

  for (const raw of allRows) {
    const event = raw && typeof raw === "object"
      ? normalizeEvent(raw)
      : null;

    if (!event) {
      invalidRows++;
      continue;
    }
    if (event.date !== date) {
      wrongDateRows++;
      continue;
    }
    unique.set(event.id, event);
  }

  return {
    events: [...unique.values()].sort(
      (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)
    ),
    diagnostics: {
      date, pages, fetchedRows: allRows.length,
      invalidRows, wrongDateRows,
      truncated: Boolean(reason),
      truncationReason: reason
    }
  };
}

async function getDate(date, fresh = false) {
  const stored = cache.get(date);
  if (!fresh && stored && Date.now() - stored.time < 15000) {
    return stored.data;
  }
  if (pending.has(date)) return pending.get(date);

  const task = fetchDate(date).then(data => {
    cache.set(date, { time: Date.now(), data });
    if (cache.size > 4) cache.delete(cache.keys().next().value);
    return data;
  });

  pending.set(date, task);
  try {
    return await task;
  } finally {
    pending.delete(date);
  }
}

const route = fn => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});

// Lightweight in-memory demo session.
// The HttpOnly cookie identifies an anonymous demo wallet.
function session(req, res, next) {
  const cookie = (req.headers.cookie || "")
    .split(";")
    .map(item => item.trim())
    .find(item => item.startsWith("demo_session="));

  const id = cookie ? cookie.slice("demo_session=".length) : "";
  let account = accounts.get(id);

  if (!account || account.expires < Date.now()) {
    const sessionId = crypto.randomBytes(32).toString("hex");
    account = {
      balance: 100000,
      csrf: crypto.randomBytes(24).toString("hex"),
      bets: [],
      requests: new Map(),
      queue: Promise.resolve(),
      expires: Date.now() + 86400000
    };
    accounts.set(sessionId, account);

    res.setHeader(
      "Set-Cookie",
      `demo_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` +
      (process.env.NODE_ENV === "production" ? "; Secure" : "")
    );
  }

  req.account = account;
  next();
}

app.get("/api/events", route(async (req, res) => {
  const filter = req.query.filter || "today";
  if (!["today", "tomorrow", "live", "all"].includes(filter)) {
    throw error(400, "Invalid filter.");
  }

  const today = dateKey();
  const tomorrow = addDay(today);
  const dates = filter === "all"
    ? [today, tomorrow]
    : [filter === "tomorrow" ? tomorrow : today];

  const feeds = await Promise.all(dates.map(date => getDate(date)));
  let events = feeds.flatMap(feed => feed.events);

  if (filter === "live") events = events.filter(event => event.live);

  // Extract leagues BEFORE applying league filtering.
  const availableLeagues = [...new Set(
    events.map(event => event.league)
  )].sort((a, b) => a.localeCompare(b));

  const league = req.query.league;
  if (league !== undefined && typeof league !== "string") {
    throw error(400, "Invalid league.");
  }

  // Exact matching, not substring matching.
  if (league) events = events.filter(event => event.league === league);

  res.json({
    success: true,
    mode: "demo",
    filter,
    dates,
    availableLeagues,
    selectedLeague: league || null,
    markets: MARKETS,
    events,
    count: events.length,
    updatedAt: new Date().toISOString(),
    diagnostics: feeds.map(feed => feed.diagnostics),
    warning: feeds.some(feed => feed.diagnostics.truncated)
      ? "Provider pagination was truncated; some matches may be missing."
      : feeds.some(feed => feed.diagnostics.wrongDateRows)
        ? "Wrong-date provider records were excluded."
        : null
  });
}));

app.get("/api/wallet", session, (req, res) => {
  res.json({
    success: true,
    balance: req.account.balance / 100,
    csrfToken: req.account.csrf,
    bets: req.account.bets
  });
});

app.post("/api/bet", session, route(async (req, res) => {
  const account = req.account;

  if (req.get("X-CSRF-Token") !== account.csrf) {
    throw error(403, "Session expired. Reload the page.");
  }

  const key = req.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) {
    throw error(400, "Valid Idempotency-Key required.");
  }

  const { stake, selections } = req.body || {};
  const cents = Math.round(stake * 100);

  if (
    typeof stake !== "number" ||
    !Number.isFinite(stake) ||
    Math.abs(stake * 100 - cents) > 0.000001 ||
    cents < 100 || cents > 100000
  ) {
    throw error(400, "Stake must be 1–1,000 with at most two decimal places.");
  }

  if (
    !Array.isArray(selections) ||
    selections.length < 1 || selections.length > 12
  ) {
    throw error(400, "Select one to twelve matches.");
  }

  const allowedDates = [dateKey(), addDay(dateKey())];
  const ids = new Set();

  for (const selection of selections) {
    if (
      !selection ||
      typeof selection.eventId !== "string" ||
      selection.eventId.length > 100 ||
      typeof selection.market !== "string" ||
      !Object.hasOwn(MARKETS, selection.market) ||
      !allowedDates.includes(selection.date) ||
      typeof selection.quotedOdds !== "number" ||
      decimal(selection.quotedOdds) === null
    ) {
      throw error(400, "Invalid selection.");
    }

    if (ids.has(selection.eventId)) {
      throw error(400, "A combo can contain only one selection per match.");
    }
    ids.add(selection.eventId);
  }

  const fingerprint = JSON.stringify({ stake, selections });

  // Serialize each wallet's requests to avoid concurrent balance deductions.
  const operation = account.queue.then(async () => {
    const previous = account.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw error(409, "Idempotency key already used for a different bet.");
      }
      return previous.response;
    }

    if (account.bets.length >= 200) {
      throw error(429, "Demo session bet limit reached.");
    }

    const dates = [...new Set(selections.map(s => s.date))];
    const feeds = await Promise.all(dates.map(date => getDate(date, true)));
    const byDate = new Map(dates.map((date, i) => [date, feeds[i]]));

    let combined = 1;
    const accepted = [];

    for (const selection of selections) {
      const event = byDate.get(selection.date).events.find(
        item => item.id === selection.eventId
      );

      if (
        !event || !event.bettable ||
        (!event.live && Date.parse(event.startTime) <= Date.now())
      ) {
        throw error(409, "A selected match is unavailable or closed.");
      }

      const quote = event.odds[selection.market];
      if (Math.abs(quote.value - selection.quotedOdds) > 0.000001) {
        throw error(409, "Odds changed. Refresh and reselect the affected match.");
      }

      combined *= quote.value;
      accepted.push({
        eventId: event.id,
        fixture: `${event.home} vs ${event.away}`,
        market: selection.market,
        odds: quote.value,
        source: quote.source,
        live: event.live,
        startTime: event.startTime
      });
    }

    if (accepted.some(
      selection => !selection.live &&
        Date.parse(selection.startTime) <= Date.now()
    )) {
      throw error(409, "A match started during validation.");
    }

    const potentialCents = Math.round(cents * combined);
    if (
      !Number.isSafeInteger(potentialCents) ||
      potentialCents > 100000000
    ) {
      throw error(400, "Potential return exceeds the demo limit.");
    }

    if (account.balance < cents) {
      throw error(409, "Insufficient demo balance.");
    }

    const bet = {
      id: crypto.randomUUID(),
      type: accepted.length === 1 ? "single" : "combo",
      selections: accepted,
      stake: cents / 100,
      combinedOdds: combined,
      potentialReturn: potentialCents / 100,
      status: "pending",
      mode: "demo",
      createdAt: new Date().toISOString()
    };

    account.balance -= cents;
    account.bets.unshift(bet);

    const response = {
      success: true,
      balance: account.balance / 100,
      bet
    };

    account.requests.set(key, { fingerprint, response });
    return response;
  });

  account.queue = operation.catch(() => {});
  res.status(201).json(await operation);
}));

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    mode: "demo",
    bsdConfigured: Boolean(API_KEY)
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.use("/api", (req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found." });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(err.message);

  const status = err.status || 502;
  res.status(status).json({
    success: false,
    error: err.status ? err.message : "Provider request failed. Please retry."
  });
});

setInterval(() => {
  for (const [id, account] of accounts) {
    if (account.expires < Date.now()) accounts.delete(id);
  }
}, 60000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Demo app listening on port ${PORT}`);
});
