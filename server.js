"use strict";

const express = require("express");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ZONE = "Africa/Addis_Ababa";
const BASE = (
  process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2"
).replace(/\/+$/, "");
const EVENTS = process.env.BSD_API_URL || `${BASE}/events/`;
const ODDS = process.env.BSD_ODDS_URL || `${BASE}/odds/`;

function setting(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max
    ? number : fallback;
}

const MAX_PAGES = setting(process.env.BSD_MAX_PAGES, 10, 1, 100);
const TIMEOUT = setting(process.env.BSD_TIMEOUT_MS, 12000, 1000, 30000);
const TTL = 30000;
const sessions = new Map();
const cache = new Map();
const pending = new Map();
const oddsCache = new Map();
const oddsPending = new Map();
const limits = new Map();

const MARKETS = Object.freeze({
  "1": { label: "Home", fallback: 1.95 },
  X: { label: "Draw", fallback: 3.20 },
  "2": { label: "Away", fallback: 3.80 },
  "1X": { label: "Home or draw", fallback: 1.25 },
  X2: { label: "Draw or away", fallback: 1.75 },
  "12": { label: "Home or away", fallback: 1.30 },
  over25: { label: "Over 2.5", fallback: 1.90 },
  under25: { label: "Under 2.5", fallback: 1.85 },
  bttsYes: { label: "BTTS Yes", fallback: 1.80 },
  bttsNo: { label: "BTTS No", fallback: 1.90 }
});

function error(status, message) {
  return Object.assign(new Error(message), { status });
}
function first(...values) {
  return values.find(v => v !== undefined && v !== null && v !== "");
}
function text(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const result = text(value.name, value.title, value.label, value.short_name);
      if (result) return result;
    }
  }
  return "";
}
function number(value) {
  if (!["string", "number"].includes(typeof value) || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function price(value) {
  const n = number(value);
  return n !== null && n > 1 && n <= 10000 ? n : null;
}
function rows(data, depth = 0) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object" || depth > 5) return [];
  for (const key of [
    "results", "data", "events", "fixtures", "matches", "items", "response", "odds"
  ]) {
    if (Array.isArray(data[key])) return data[key];
    const result = rows(data[key], depth + 1);
    if (result.length) return result;
  }
  return [];
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit"
});
function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(date).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}
function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
function parseStart(value) {
  if (typeof value === "number" ||
      (typeof value === "string" && /^(\d{10}(?:\.\d+)?|\d{13})$/.test(value))) {
    const n = Number(value);
    const date = new Date(Math.abs(n) < 1e12 ? n * 1000 : n);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string") return null;
  let source = value.trim().replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T");
  if (validDate(source)) source += "T00:00:00+03:00";
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(source)) {
    source += process.env.BSD_NAIVE_TIME_OFFSET || "Z";
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(source)) return null;
  if (!validDate(source.slice(0, 10))) return null;
  const date = new Date(source);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeOdds(event) {
  const source = first(event.odds, event.prices, event.markets, event.bets) || {};
  const result = {};

  function assign(key, ...values) {
    if (!Object.hasOwn(MARKETS, key)) return;
    for (const value of values) {
      const valid = price(value);
      if (valid !== null) {
        result[key] = { value: valid, source: "provider" };
        return;
      }
    }
  }

  if (!Array.isArray(source)) {
    for (const key of Object.keys(MARKETS)) {
      assign(key, source[key], source.doubleChance?.[key]);
    }
    assign("1", event.home_odds, event.homeOdds, event.odds_home, source.home);
    assign("X", event.draw_odds, event.drawOdds, event.odds_draw, source.draw, source.x);
    assign("2", event.away_odds, event.awayOdds, event.odds_away, source.away);
    assign("over25", source.over_2_5, source.over_25_goals);
    assign("under25", source.under_2_5, source.under_25_goals);
    assign("bttsYes", source.btts_yes);
    assign("bttsNo", source.btts_no);
  }

  function walk(value, inherited = {}, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach(item => walk(item, inherited, depth + 1));
      return;
    }
    const market = text(value.market, value.market_name, inherited.market)
      .toLowerCase().replace(/[\s-]+/g, "_");
    const outcome = text(value.outcome, value.outcome_name, value.selection, value.name)
      .toLowerCase().replace(/[\s-]+/g, "_");
    const line = number(first(value.line, value.total, inherited.line));
    let key;

    if (["1x2", "match_winner", "full_time_result", "winner"].includes(market)) {
      key = ({
        home: "1", home_win: "1", "1": "1", draw: "X", tie: "X", x: "X",
        away: "2", away_win: "2", "2": "2"
      })[outcome];
    } else if (market === "double_chance") {
      key = ({
        "1x": "1X", home_or_draw: "1X", x2: "X2",
        draw_or_away: "X2", "12": "12", home_or_away: "12"
      })[outcome];
    } else if (["btts", "both_teams_to_score"].includes(market)) {
      key = ({ yes: "bttsYes", no: "bttsNo", btts_yes: "bttsYes", btts_no: "bttsNo" })[outcome];
    } else if (
      ["over_under_25", "over_under_2_5", "totals_25"].includes(market) ||
      (["totals", "over_under"].includes(market) && line === 2.5)
    ) {
      key = ({ over: "over25", under: "under25" })[outcome];
    }
    if (key) assign(key, value.decimal_odds, value.decimalOdds, value.price, value.odds);
    for (const child of ["outcomes", "selections", "markets", "bets", "odds", "results"]) {
      if (value[child] && typeof value[child] === "object") {
        walk(value[child], { market, line }, depth + 1);
      }
    }
  }
  walk(source);

  for (const [key, info] of Object.entries(MARKETS)) {
    if (!result[key]) result[key] = { value: info.fallback, source: "demo" };
  }
  return result;
}

function normalize(event) {
  const id = first(event.id, event.event_id, event.eventId,
    event.fixture_id, event.fixture?.id, event.match_id);
  if (!["string", "number"].includes(typeof id)) return null;

  const home = text(event.home, event.home_team, event.homeTeam, event.teams?.home,
    event.localteam, event.home_name, event.home_team_name);
  const away = text(event.away, event.away_team, event.awayTeam, event.teams?.away,
    event.visitorteam, event.away_name, event.away_team_name);
  const start = [
    event.start_time, event.startTime, event.starts_at, event.kickoff,
    event.kickoff_time, event.datetime, event.scheduled_at, event.fixture?.date,
    event.timestamp, event.start, event.event_date, event.date
  ].map(parseStart).find(Boolean);
  if (!home || !away || !start) return null;

  const status = text(event.status, event.state, event.match_status, event.status_name)
    .toLowerCase().replace(/[_-]/g, " ");
  const closed = /\b(finished|complete|completed|ft|ended|full time|cancelled|canceled|postponed|abandoned|suspended)\b/.test(status);
  const live = !closed && (
    event.live === true || event.is_live === true ||
    /\b(live|in progress|inplay|in play|playing|1st half|2nd half|half time|halftime)\b/.test(status)
  );

  return {
    id: String(id), home, away, startTime: start, date: dateKey(start),
    league: text(event.league_name, event.competition_name,
      event.tournament_name, event.league, event.competition, event.tournament)
      || "Unspecified competition",
    live,
    status: closed ? "closed" : live ? "live" : "upcoming",
    bettable: !closed && !live && Date.parse(start) > Date.now(),
    score: {
      home: number(first(event.home_score, event.score?.home, event.goals?.home)),
      away: number(first(event.away_score, event.score?.away, event.goals?.away))
    },
    odds: normalizeOdds(event)
  };
}

async function fetchBSD(url) {
  if (!process.env.BSD_API_KEY) throw error(503, "BSD_API_KEY is not configured.");
  const response = await fetch(url, {
    headers: {
      Authorization: `Token ${process.env.BSD_API_KEY}`,
      Accept: "application/json"
    },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!response.ok) throw error(502, `BSD returned HTTP ${response.status}.`);
  return response.json();
}
function nextLink(data) {
  for (const container of [data, data?.data, data?.response]) {
    const next = first(container?.next, container?.pagination?.next, container?.links?.next);
    if (typeof next === "string" && next.trim()) return next;
    const href = next && first(next.href, next.url);
    if (typeof href === "string" && href.trim()) return href;
  }
  return null;
}
async function fetchPages(initialUrl, required = {}) {
  const initial = new URL(initialUrl);
  const visited = new Set();
  const result = [];
  let url = initial.href;
  let pages = 0;
  let reason = null;
  const deadline = Date.now() + 45000;

  while (url) {
    if (pages >= MAX_PAGES) { reason = "page_limit"; break; }
    if (Date.now() >= deadline) { reason = "time_budget"; break; }
    if (visited.has(url)) { reason = "pagination_cycle"; break; }
    visited.add(url);
    const data = await fetchBSD(url);
    result.push(...rows(data));
    pages++;

    const next = nextLink(data);
    if (!next) break;
    const resolved = new URL(next, url);
    if (
      resolved.origin !== initial.origin ||
      resolved.pathname !== initial.pathname ||
      resolved.username || resolved.password
    ) throw error(502, "Unsafe provider pagination URL.");
    for (const [key, value] of Object.entries(required)) {
      resolved.searchParams.set(key, value);
    }
    resolved.hash = "";
    url = resolved.href;
  }
  return { rows: result, pages, truncated: Boolean(reason), reason };
}

async function feed(date, fresh = false) {
  const cached = cache.get(date);
  if (!fresh && cached && Date.now() - cached.at < TTL) return cached.data;
  if (pending.has(date)) return pending.get(date);

  const job = (async () => {
    const url = new URL(EVENTS);
    url.searchParams.set("date", date);
    const fetched = await fetchPages(url.href, { date });
    const unique = new Map();
    let invalidRows = 0;
    let wrongDateRows = 0;

    for (const raw of fetched.rows) {
      const event = raw && typeof raw === "object" ? normalize(raw) : null;
      if (!event) { invalidRows++; continue; }
      if (event.date !== date) { wrongDateRows++; continue; }
      unique.set(event.id, event);
    }
    const data = {
      events: [...unique.values()].sort(
        (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)
      ),
      updatedAt: new Date().toISOString(),
      diagnostics: {
        fetchedRows: fetched.rows.length, invalidRows, wrongDateRows,
        pages: fetched.pages, truncated: fetched.truncated,
        truncationReason: fetched.reason
      }
    };
    cache.set(date, { at: Date.now(), data });
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return data;
  })();
  pending.set(date, job);
  try { return await job; }
  finally { pending.delete(date); }
}

async function eventOdds(event) {
  const cached = oddsCache.get(event.id);
  if (cached && Date.now() - cached.at < 15000) return cached.odds;
  if (oddsPending.has(event.id)) return oddsPending.get(event.id);

  const job = (async () => {
    const result = structuredClone(event.odds);
    try {
      const url = new URL(ODDS);
      url.searchParams.set("event_id", event.id);
      const fetched = await fetchPages(url.href, { event_id: event.id });
      const extra = normalizeOdds({ odds: fetched.rows });
      for (const key of Object.keys(MARKETS)) {
        if (extra[key].source === "provider") result[key] = extra[key];
      }
      oddsCache.set(event.id, { at: Date.now(), odds: result });
      if (oddsCache.size > 1000) oddsCache.delete(oddsCache.keys().next().value);
    } catch (err) {
      console.error("Odds refresh failed:", err.message);
    }
    return result;
  })();
  oddsPending.set(event.id, job);
  try { return await job; }
  finally { oddsPending.delete(event.id); }
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  });
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use("/api", (req, res, next) => {
  const now = Date.now();
  let entry = limits.get(req.ip);
  if (!entry || entry.expires < now) {
    entry = { expires: now + 60000, count: 0 };
    limits.set(req.ip, entry);
  }
  if (++entry.count > 180) {
    res.set("Retry-After", "60");
    return res.status(429).json({ success: false, error: "Too many requests." });
  }
  next();
});
app.use(express.json({ limit: "32kb" }));

function session(req, res, next) {
  const cookie = (req.headers.cookie || "")
    .split(";").map(v => v.trim()).find(v => v.startsWith("matchday="));
  const token = cookie ? cookie.slice("matchday=".length) : "";
  let account = sessions.get(token);

  if (!account || account.expires < Date.now()) {
    const id = randomBytes(32).toString("hex");
    account = {
      balance: 100000, csrf: randomBytes(24).toString("hex"),
      bets: [], requests: new Map(),
      expires: Date.now() + 86400000,
      queue: Promise.resolve()
    };
    sessions.set(id, account);
    res.setHeader("Set-Cookie",
      `matchday=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` +
      (process.env.NODE_ENV === "production" ? "; Secure" : "")
    );
  }
  req.account = account;
  next();
}
function wallet(account) {
  return { balance: account.balance / 100, currency: "DEMO" };
}
const route = handler => (req, res, next) =>
  Promise.resolve(handler(req, res)).catch(next);

function selectedDate(req) {
  const date = req.query.date || dateKey();
  if (!validDate(date)) throw error(400, "Use date=YYYY-MM-DD.");
  const difference = (
    Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dateKey()}T00:00:00Z`)
  ) / 86400000;
  if (difference < 0 || difference > 7) throw error(400, "Date must be within the next seven days.");
  return date;
}

app.get("/api/events", route(async (req, res) => {
  const tab = req.query.filter || "today";
  if (!["live", "today", "tomorrow", "all"].includes(tab)) {
    throw error(400, "Invalid filter.");
  }
  const date = selectedDate(req);
  // "All" means today and tomorrow, not the entire provider database.
  const dates = tab === "all" ? [date, addDays(date, 1)] : [date];
  const results = await Promise.all(dates.map(d => feed(d)));
  let events = results.flatMap(result => result.events);
  if (tab === "live") events = events.filter(event => event.live);
  const availableLeagues = [...new Set(events.map(event => event.league))].sort();
  if (typeof req.query.league === "string" && req.query.league) {
    events = events.filter(event => event.league === req.query.league);
  }
  const incomplete = results.some(result => result.diagnostics.truncated);
  const mismatch = results.some(result => result.diagnostics.wrongDateRows);
  res.json({
    success: true, mode: "demo", date, dates, timeZone: ZONE,
    markets: MARKETS, availableLeagues, events, count: events.length,
    updatedAt: results[0].updatedAt,
    diagnostics: results.map((result, index) => ({
      date: dates[index], ...result.diagnostics
    })),
    warning: incomplete ? "Provider pagination is incomplete; some matches may be missing."
      : mismatch ? "Wrong-date provider records were excluded." : null
  });
}));

app.get("/api/events/:id/odds", route(async (req, res) => {
  const date = selectedDate(req);
  const result = await feed(date);
  const event = result.events.find(e => e.id === req.params.id);
  if (!event) throw error(404, "Match not found for this date.");
  res.json({ success: true, odds: await eventOdds(event) });
}));

app.get("/api/wallet", session, (req, res) => {
  res.json({
    success: true, mode: "demo", wallet: wallet(req.account),
    csrfToken: req.account.csrf, bets: req.account.bets
  });
});

app.post("/api/bet", session, route(async (req, res) => {
  const account = req.account;
  if (req.get("X-CSRF-Token") !== account.csrf) {
    throw error(403, "Session expired. Reload the app.");
  }
  const key = req.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) {
    throw error(400, "Valid Idempotency-Key required.");
  }
  const { selections, stake } = req.body || {};
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 12) {
    throw error(400, "Choose between one and twelve matches.");
  }
  const cents = Math.round(stake * 100);
  if (
    typeof stake !== "number" || !Number.isFinite(stake) ||
    Math.abs(stake * 100 - cents) > 0.000001 ||
    cents < 100 || cents > 100000
  ) throw error(400, "Stake must be 1.00–1,000.00, with at most two decimal places.");

  const seen = new Set();
  for (const selection of selections) {
    if (
      !selection || typeof selection.eventId !== "string" ||
      selection.eventId.length > 100 ||
      typeof selection.market !== "string" ||
      !Object.hasOwn(MARKETS, selection.market) ||
      !validDate(selection.date) ||
      ![dateKey(), addDays(dateKey(), 1)].includes(selection.date) ||
      typeof selection.quotedOdds !== "number"
    ) throw error(400, "Invalid selection.");
    if (seen.has(selection.eventId)) {
      throw error(400, "Only one selection per match is allowed in a combo.");
    }
    seen.add(selection.eventId);
  }

  const fingerprint = JSON.stringify({ selections, cents });
  const operation = account.queue.then(async () => {
    const previous = account.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw error(409, "Idempotency key already used.");
      return previous.response;
    }
    if (account.bets.length >= 200) throw error(429, "Demo bet limit reached.");

    const dates = [...new Set(selections.map(s => s.date))];
    const fetched = await Promise.all(dates.map(d => feed(d, true)));
    const byDate = new Map(dates.map((d, i) => [d, fetched[i]]));
    const accepted = [];
    let combinedOdds = 1;

    for (const selection of selections) {
      const event = byDate.get(selection.date).events.find(e => e.id === selection.eventId);
      if (!event || !event.bettable || Date.parse(event.startTime) <= Date.now()) {
        throw error(409, "A selected match is unavailable or betting has closed.");
      }
      const odds = await eventOdds(event);
      const quote = odds[selection.market];
      if (Math.abs(quote.value - selection.quotedOdds) > 0.000001) {
        throw error(409, "Odds changed. Remove and reselect the affected match.");
      }
      combinedOdds *= quote.value;
      accepted.push({
        eventId: event.id, fixture: `${event.home} vs ${event.away}`,
        market: selection.market, label: MARKETS[selection.market].label,
        odds: quote.value, source: quote.source,
        startTime: event.startTime
      });
    }
    if (accepted.some(s => Date.parse(s.startTime) <= Date.now())) {
      throw error(409, "Betting closed while validating your slip.");
    }
    const potentialCents = Math.round(cents * combinedOdds);
    if (!Number.isSafeInteger(potentialCents) || potentialCents > 100000000) {
      throw error(400, "Potential return exceeds the demo limit.");
    }
    if (account.balance < cents) throw error(409, "Insufficient demo balance.");

    const bet = {
      id: randomUUID(), type: accepted.length === 1 ? "single" : "combo",
      selections: accepted, stake: cents / 100,
      odds: combinedOdds, potentialReturn: potentialCents / 100,
      status: "pending", mode: "demo", createdAt: new Date().toISOString()
    };
    account.balance -= cents;
    account.bets.unshift(bet);
    const response = { success: true, bet, wallet: wallet(account) };
    account.requests.set(key, { fingerprint, response });
    return response;
  });
  account.queue = operation.catch(() => {});
  res.status(201).json(await operation);
}));

app.get("/api/health", (req, res) => {
  res.json({
    success: true, mode: "demo",
    bsdConfigured: Boolean(process.env.BSD_API_KEY),
    time: new Date().toISOString()
  });
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "betting.html"));
});
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found." });
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("Request error:", err.message);
  const status = err.type === "entity.parse.failed" ? 400 :
    err.type === "entity.too.large" ? 413 :
    Number.isInteger(err.status) ? err.status : 502;
  res.status(status).json({
    success: false,
    error: err.type === "entity.parse.failed" ? "Invalid JSON." :
      status === 502 && !err.status ? "Provider connection failed. Please retry." : err.message
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
  for (const [key, value] of limits) if (value.expires < now) limits.delete(key);
  for (const [key, value] of oddsCache) if (now - value.at > 60000) oddsCache.delete(key);
}, 60000).unref();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matchday demo listening on ${PORT}`);
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
});
