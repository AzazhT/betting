"use strict";

const express = require("express");
const { randomBytes, randomUUID } = require("node:crypto");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ZONE = "Africa/Addis_Ababa";
const BASE = (
  process.env.BSD_BASE_URL || "https://sports.bzzoiro.com/api/v2"
).replace(/\/+$/, "");
const EVENTS_URL = process.env.BSD_API_URL || `${BASE}/events/`;
const ODDS_URL = process.env.BSD_ODDS_URL || `${BASE}/odds/`;

function setting(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const MAX_PAGES = setting(process.env.BSD_MAX_PAGES, 10, 1, 100);
const TIMEOUT = setting(process.env.BSD_TIMEOUT_MS, 12000, 1000, 30000);
const feedCache = new Map();
const feedPending = new Map();
const oddsCache = new Map();
const oddsPending = new Map();
const sessions = new Map();
const limits = new Map();

const MARKETS = {
  "1": { label: "Home", group: "Match result", fallback: 1.95 },
  X: { label: "Draw", group: "Match result", fallback: 3.20 },
  "2": { label: "Away", group: "Match result", fallback: 3.80 },
  "1X": { label: "Home or draw", group: "Double chance", fallback: 1.25 },
  X2: { label: "Draw or away", group: "Double chance", fallback: 1.75 },
  "12": { label: "Home or away", group: "Double chance", fallback: 1.30 },
  over15: { label: "Over 1.5", group: "Goals · 1.5", fallback: 1.35 },
  under15: { label: "Under 1.5", group: "Goals · 1.5", fallback: 2.90 },
  over25: { label: "Over 2.5", group: "Goals · 2.5", fallback: 1.90 },
  under25: { label: "Under 2.5", group: "Goals · 2.5", fallback: 1.85 },
  over35: { label: "Over 3.5", group: "Goals · 3.5", fallback: 3.10 },
  under35: { label: "Under 3.5", group: "Goals · 3.5", fallback: 1.30 },
  bttsYes: { label: "Yes", group: "Both teams to score", fallback: 1.80 },
  bttsNo: { label: "No", group: "Both teams to score", fallback: 1.90 },
  cornersOver85: { label: "Over 8.5", group: "Corners · 8.5", fallback: 1.65 },
  cornersUnder85: { label: "Under 8.5", group: "Corners · 8.5", fallback: 2.15 },
  cornersOver95: { label: "Over 9.5", group: "Corners · 9.5", fallback: 1.90 },
  cornersUnder95: { label: "Under 9.5", group: "Corners · 9.5", fallback: 1.85 },
  cornersOver105: { label: "Over 10.5", group: "Corners · 10.5", fallback: 2.25 },
  cornersUnder105: { label: "Under 10.5", group: "Corners · 10.5", fallback: 1.60 }
};

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
function first(...values) {
  return values.find(v => v !== undefined && v !== null && v !== "");
}
function text(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const found = text(v.name, v.title, v.label, v.short_name);
      if (found) return found;
    }
  }
  return "";
}
function numeric(v) {
  if (!["string", "number"].includes(typeof v) || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function validOdds(v) {
  const n = numeric(v);
  return n !== null && n > 1 && n <= 10000 ? n : null;
}
function list(data, depth = 0) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object" || depth > 5) return [];
  for (const key of [
    "results", "data", "events", "fixtures", "matches", "items", "response", "odds"
  ]) {
    const found = list(data[key], depth + 1);
    if (Array.isArray(data[key]) || found.length) return found;
  }
  return [];
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit"
});

function dateKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(d).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === value;
}
function nextDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function parseStart(value) {
  if (typeof value === "number" ||
      (typeof value === "string" && /^(\d{10}(?:\.\d+)?|\d{13})$/.test(value))) {
    const n = Number(value);
    const d = new Date(Math.abs(n) < 1e12 ? n * 1000 : n);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value !== "string") return null;
  let s = value.trim().replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T");
  if (validDate(s)) s += "T00:00:00+03:00";
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s)) {
    s += process.env.BSD_NAIVE_TIME_OFFSET || "Z";
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  if (!validDate(s.slice(0, 10))) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function token(value) {
  return text(value).toLowerCase().replace(/[\s.-]+/g, "_");
}

function normalizeOdds(event) {
  const result = {};
  const source = first(event.odds, event.prices, event.markets, event.bets) || {};

  function assign(key, ...values) {
    if (!Object.hasOwn(MARKETS, key)) return;
    for (const value of values) {
      const n = validOdds(value);
      if (n !== null) {
        result[key] = { value: n, source: "provider" };
        return;
      }
    }
  }

  if (!Array.isArray(source)) {
    for (const key of Object.keys(MARKETS)) assign(key, source[key]);
    assign("1", event.home_odds, event.homeOdds, event.odds_home, source.home);
    assign("X", event.draw_odds, event.drawOdds, event.odds_draw, source.draw, source.x);
    assign("2", event.away_odds, event.awayOdds, event.odds_away, source.away);
    for (const key of ["1X", "X2", "12"]) {
      assign(key, source.doubleChance?.[key], source.double_chance?.[key]);
    }
    for (const line of ["15", "25", "35"]) {
      for (const side of ["over", "under"]) {
        assign(`${side}${line}`, source[`${side}_${line}`],
          source[`${side}_${line[0]}_${line[1]}`]);
      }
    }
    assign("bttsYes", source.btts_yes);
    assign("bttsNo", source.btts_no);
    for (const line of ["85", "95", "105"]) {
      assign(`cornersOver${line}`, source[`corners_over_${line}`]);
      assign(`cornersUnder${line}`, source[`corners_under_${line}`]);
    }
  }

  function walk(value, inherited = {}, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach(v => walk(v, inherited, depth + 1));
      return;
    }
    const market = token(first(value.market, value.market_name, inherited.market));
    const outcome = token(first(
      value.outcome, value.outcome_name, value.selection, value.name
    ));
    const line = numeric(first(value.line, value.total, inherited.line));
    const amount = first(
      value.decimal_odds, value.decimalOdds, value.price,
      typeof value.odds !== "object" ? value.odds : undefined
    );
    let key;

    if (["1x2", "match_winner", "full_time_result", "winner"].includes(market)) {
      key = ({
        home: "1", home_win: "1", "1": "1",
        draw: "X", tie: "X", x: "X",
        away: "2", away_win: "2", "2": "2"
      })[outcome];
    } else if (market === "double_chance") {
      key = ({
        "1x": "1X", home_or_draw: "1X",
        x2: "X2", draw_or_away: "X2",
        "12": "12", home_or_away: "12"
      })[outcome];
    } else if (["btts", "both_teams_to_score"].includes(market)) {
      key = ({
        yes: "bttsYes", no: "bttsNo",
        btts_yes: "bttsYes", btts_no: "bttsNo"
      })[outcome];
    } else {
      const corners = market.includes("corner");
      const supported = corners ? [8.5, 9.5, 10.5] : [1.5, 2.5, 3.5];

      for (const total of supported) {
        const suffix = String(total).replace(".", "");
        const separated = String(total).replace(".", "_");
        const goalAliases = [
          `over_under_${suffix}`, `over_under_${separated}`, `totals_${suffix}`
        ];
        const cornerAliases = [
          `corners_${suffix}`, `corners_${separated}`,
          `corners_over_under_${suffix}`, `corners_over_under_${separated}`
        ];
        const generic = corners
          ? ["corners", "total_corners", "corners_over_under", "corners_totals"]
          : ["totals", "over_under", "total_goals"];

        if (
          (corners ? cornerAliases : goalAliases).includes(market) ||
          (generic.includes(market) && line === total)
        ) {
          if (["over", "under"].includes(outcome)) {
            key = corners
              ? `corners${outcome === "over" ? "Over" : "Under"}${suffix}`
              : `${outcome}${suffix}`;
          }
        }
      }
    }
    if (key) assign(key, amount);

    for (const child of ["outcomes", "selections", "markets", "bets", "odds", "results"]) {
      if (value[child] && typeof value[child] === "object") {
        walk(value[child], { market, line }, depth + 1);
      }
    }
  }
  walk(source);

  for (const [key, market] of Object.entries(MARKETS)) {
    if (!result[key]) result[key] = { value: market.fallback, source: "demo" };
  }
  return result;
}

function normalizeEvent(raw) {
  const id = first(raw.id, raw.event_id, raw.eventId,
    raw.fixture_id, raw.fixture?.id, raw.match_id);
  if (!["string", "number"].includes(typeof id)) return null;

  const home = text(raw.home, raw.home_team, raw.homeTeam, raw.teams?.home,
    raw.localteam, raw.home_name, raw.home_team_name);
  const away = text(raw.away, raw.away_team, raw.awayTeam, raw.teams?.away,
    raw.visitorteam, raw.away_name, raw.away_team_name);
  const startTime = [
    raw.start_time, raw.startTime, raw.starts_at, raw.kickoff,
    raw.kickoff_time, raw.datetime, raw.scheduled_at, raw.fixture?.date,
    raw.timestamp, raw.start, raw.event_date, raw.date
  ].map(parseStart).find(Boolean);
  if (!home || !away || !startTime) return null;

  const state = text(raw.status, raw.state, raw.match_status, raw.status_name)
    .toLowerCase().replace(/[_-]/g, " ");
  const closed = /\b(finished|complete|completed|ft|ended|full time|cancelled|canceled|postponed|abandoned|suspended)\b/.test(state);
  const live = !closed && (
    raw.live === true || raw.is_live === true || raw.isLive === true ||
    /\b(live|in progress|inplay|in play|playing|1st half|2nd half|half time|halftime|extra time)\b/.test(state)
  );

  return {
    id: String(id), home, away, startTime,
    date: dateKey(startTime),
    league: text(raw.league_name, raw.competition_name, raw.tournament_name,
      raw.league, raw.competition, raw.tournament) || "Unspecified competition",
    status: closed ? "closed" : live ? "live" : "upcoming",
    live,
    // Live betting is supported here for DEMO credits only.
    bettable: !closed && (live || Date.parse(startTime) > Date.now()),
    score: {
      home: numeric(first(raw.home_score, raw.score?.home, raw.goals?.home)),
      away: numeric(first(raw.away_score, raw.score?.away, raw.goals?.away))
    },
    odds: normalizeOdds(raw)
  };
}

async function fetchBSD(url) {
  if (!process.env.BSD_API_KEY) throw fail(503, "BSD_API_KEY is not configured.");
  const response = await fetch(url, {
    headers: {
      Authorization: `Token ${process.env.BSD_API_KEY}`,
      Accept: "application/json"
    },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!response.ok) throw fail(502, `BSD returned HTTP ${response.status}.`);
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
async function fetchPages(initialUrl, required) {
  const initial = new URL(initialUrl);
  const seen = new Set();
  const rows = [];
  const deadline = Date.now() + 45000;
  let url = initial.href;
  let pages = 0;
  let reason = null;

  while (url) {
    if (pages >= MAX_PAGES) { reason = "page_limit"; break; }
    if (Date.now() >= deadline) { reason = "time_budget"; break; }
    if (seen.has(url)) { reason = "pagination_cycle"; break; }
    seen.add(url);
    const data = await fetchBSD(url);
    rows.push(...list(data));
    pages++;

    const next = nextLink(data);
    if (!next) break;
    const resolved = new URL(next, url);
    if (resolved.origin !== initial.origin ||
        resolved.pathname !== initial.pathname ||
        resolved.username || resolved.password) {
      throw fail(502, "Unsafe provider pagination URL.");
    }
    for (const [key, value] of Object.entries(required)) {
      resolved.searchParams.set(key, value);
    }
    resolved.hash = "";
    url = resolved.href;
  }
  return { rows, pages, truncated: Boolean(reason), reason };
}

async function getFeed(date, fresh = false) {
  const cached = feedCache.get(date);
  if (!fresh && cached && Date.now() - cached.at < 15000) return cached.data;
  if (feedPending.has(date)) return feedPending.get(date);

  const job = (async () => {
    const url = new URL(EVENTS_URL);
    url.searchParams.set("date", date);
    const fetched = await fetchPages(url.href, { date });
    const events = new Map();
    let invalidRows = 0;
    let wrongDateRows = 0;

    for (const raw of fetched.rows) {
      const event = raw && typeof raw === "object" ? normalizeEvent(raw) : null;
      if (!event) { invalidRows++; continue; }
      if (event.date !== date) { wrongDateRows++; continue; }
      events.set(event.id, event);
    }

    const data = {
      events: [...events.values()].sort(
        (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)
      ),
      updatedAt: new Date().toISOString(),
      diagnostics: {
        pages: fetched.pages, fetchedRows: fetched.rows.length,
        invalidRows, wrongDateRows, truncated: fetched.truncated,
        truncationReason: fetched.reason
      }
    };
    feedCache.set(date, { at: Date.now(), data });
    if (feedCache.size > 8) feedCache.delete(feedCache.keys().next().value);
    return data;
  })();
  feedPending.set(date, job);
  try { return await job; }
  finally { feedPending.delete(date); }
}

async function getOdds(event, fresh = false) {
  const cached = oddsCache.get(event.id);
  if (!fresh && cached && Date.now() - cached.at < 10000) return cached.odds;
  if (oddsPending.has(event.id)) return oddsPending.get(event.id);

  const job = (async () => {
    const result = structuredClone(event.odds);
    try {
      const url = new URL(ODDS_URL);
      url.searchParams.set("event_id", event.id);
      const fetched = await fetchPages(url.href, { event_id: event.id });
      const extra = normalizeOdds({ odds: fetched.rows });
      for (const key of Object.keys(MARKETS)) {
        // Fallback prices never overwrite genuine provider prices.
        if (extra[key].source === "provider") result[key] = extra[key];
      }
      oddsCache.set(event.id, { at: Date.now(), odds: result });
      if (oddsCache.size > 1000) oddsCache.delete(oddsCache.keys().next().value);
    } catch (err) {
      console.error("Odds refresh unavailable:", err.message);
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
  if (!entry || entry.expires <= now) {
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
  const cookie = (req.headers.cookie || "").split(";")
    .map(v => v.trim()).find(v => v.startsWith("matchday="));
  const token = cookie ? cookie.slice(9) : "";
  let account = sessions.get(token);
  if (!account || account.expires <= Date.now()) {
    const id = randomBytes(32).toString("hex");
    account = {
      balance: 100000, csrf: randomBytes(24).toString("hex"),
      bets: [], requests: new Map(), queue: Promise.resolve(),
      expires: Date.now() + 86400000
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
const route = fn => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);

function selectedDate(req, fallback = dateKey()) {
  const date = req.query.date || fallback;
  if (!validDate(date)) throw fail(400, "Use date=YYYY-MM-DD.");
  const difference = (
    Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dateKey()}T00:00:00Z`)
  ) / 86400000;
  if (difference < 0 || difference > 6) {
    throw fail(400, "Choose a date within the next seven days.");
  }
  return date;
}

app.get("/api/events", route(async (req, res) => {
  const filter = req.query.filter || "today";
  if (!["today", "tomorrow", "live", "all"].includes(filter)) {
    throw fail(400, "Invalid filter.");
  }
  const date = selectedDate(req, filter === "tomorrow" ? nextDay(dateKey()) : dateKey());
  const dates = filter === "all" ? [date, nextDay(date)] : [date];
  const feeds = await Promise.all(dates.map(d => getFeed(d)));
  let events = feeds.flatMap(f => f.events);
  if (filter === "live") events = events.filter(e => e.live);

  // Build options before league filtering, so users can switch leagues.
  const availableLeagues = [...new Set(events.map(e => e.league))].sort();
  const league = req.query.league;
  if (league !== undefined && typeof league !== "string") {
    throw fail(400, "Invalid league parameter.");
  }
  if (league) events = events.filter(e => e.league === league);

  res.json({
    success: true, mode: "demo", filter, date, dates,
    selectedLeague: league || null, availableLeagues,
    timeZone: ZONE, markets: MARKETS, count: events.length, events,
    updatedAt: feeds[0].updatedAt,
    diagnostics: feeds.map((f, i) => ({ date: dates[i], ...f.diagnostics })),
    warning: feeds.some(f => f.diagnostics.truncated)
      ? "Provider response is incomplete; some matches may be missing."
      : feeds.some(f => f.diagnostics.wrongDateRows)
        ? "Wrong-date provider records were excluded." : null
  });
}));

app.get("/api/events/:id/odds", route(async (req, res) => {
  const date = selectedDate(req);
  const feed = await getFeed(date);
  const event = feed.events.find(e => e.id === req.params.id);
  if (!event) throw fail(404, "Match not found for this date.");
  res.json({ success: true, mode: "demo", odds: await getOdds(event) });
}));

app.get("/api/wallet", session, (req, res) => {
  res.json({
    success: true, wallet: wallet(req.account),
    csrfToken: req.account.csrf, bets: req.account.bets
  });
}));

app.post("/api/bet", session, route(async (req, res) => {
  const account = req.account;
  if (req.get("X-CSRF-Token") !== account.csrf) {
    throw fail(403, "Session expired. Reload the page.");
  }
  const key = req.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) {
    throw fail(400, "Valid Idempotency-Key required.");
  }
  const { selections, stake } = req.body || {};
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 12) {
    throw fail(400, "Choose one to twelve matches.");
  }
  const cents = Math.round(stake * 100);
  if (typeof stake !== "number" || !Number.isFinite(stake) ||
      Math.abs(stake * 100 - cents) > 0.000001 ||
      cents < 100 || cents > 100000) {
    throw fail(400, "Stake must be 1.00–1,000.00, with at most two decimal places.");
  }
  const seen = new Set();
  for (const s of selections) {
    if (!s || typeof s.eventId !== "string" || s.eventId.length > 100 ||
        typeof s.market !== "string" || !Object.hasOwn(MARKETS, s.market) ||
        !validDate(s.date) || ![dateKey(), nextDay(dateKey())].includes(s.date) ||
        typeof s.quotedOdds !== "number" || validOdds(s.quotedOdds) === null) {
      throw fail(400, "Invalid selection. Betting is available for today and tomorrow.");
    }
    if (seen.has(s.eventId)) throw fail(400, "Choose only one market per match in a combo.");
    seen.add(s.eventId);
  }

  const fingerprint = JSON.stringify({ selections, cents });
  const operation = account.queue.then(async () => {
    const previous = account.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw fail(409, "Idempotency key already used.");
      return previous.response;
    }
    if (account.bets.length >= 200) throw fail(429, "Demo bet limit reached.");

    const dates = [...new Set(selections.map(s => s.date))];
    const feeds = await Promise.all(dates.map(d => getFeed(d, true)));
    const byDate = new Map(dates.map((d, i) => [d, feeds[i]]));
    const accepted = [];
    let combined = 1;

    for (const s of selections) {
      const event = byDate.get(s.date).events.find(e => e.id === s.eventId);
      if (!event || !event.bettable ||
          (!event.live && Date.parse(event.startTime) <= Date.now())) {
        throw fail(409, "A match is unavailable or betting has closed.");
      }
      const odds = await getOdds(event, true);
      const quote = odds[s.market];
      if (Math.abs(quote.value - s.quotedOdds) > 0.000001) {
        throw fail(409, "Odds changed. Remove and reselect the affected selection.");
      }
      combined *= quote.value;
      accepted.push({
        eventId: event.id, fixture: `${event.home} vs ${event.away}`,
        market: s.market, label: `${MARKETS[s.market].group}: ${MARKETS[s.market].label}`,
        odds: quote.value, source: quote.source, live: event.live,
        startTime: event.startTime
      });
    }
    if (accepted.some(s => !s.live && Date.parse(s.startTime) <= Date.now())) {
      throw fail(409, "A match started while validating your slip.");
    }
    const potential = Math.round(cents * combined);
    if (!Number.isSafeInteger(potential) || potential > 100000000) {
      throw fail(400, "Potential return exceeds the demo limit.");
    }
    if (account.balance < cents) throw fail(409, "Insufficient demo balance.");

    const bet = {
      id: randomUUID(), type: accepted.length === 1 ? "single" : "combo",
      selections: accepted, stake: cents / 100, odds: combined,
      potentialReturn: potential / 100, status: "pending",
      mode: "demo", createdAt: new Date().toISOString()
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

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1415">
<title>Matchday · Football Demo</title>
<script src="https://telegram.org/js/telegram-web-app.js" defer></script>
<style>
:root{color-scheme:dark;--bg:#0b1415;--panel:#142122;--raised:#1c2d2e;--line:#2b4040;--text:#edf7f3;--muted:#9bb1aa;--green:#6de7a7;--red:#ffa3ad}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
button,input,select{font:inherit;color:var(--text);background:var(--raised);border:1px solid var(--line);border-radius:10px}
button{cursor:pointer;min-height:44px}button:hover:not(:disabled){border-color:var(--green)}
button:disabled{opacity:.55;cursor:not-allowed}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--green);outline-offset:3px}
[hidden]{display:none!important}
header{background:#123326;padding:calc(16px + env(safe-area-inset-top)) 20px 16px;border-bottom:1px solid #315942}
.header-inner{max-width:1240px;margin:auto;display:flex;justify-content:space-between;align-items:center}
.brand{font-size:25px;font-weight:900;letter-spacing:-1px}.brand span{color:var(--green)}
.wallet{text-align:right}.wallet small{display:block;color:var(--muted)}.wallet strong{color:var(--green)}
main{max-width:1240px;margin:auto;padding:24px 18px 40px}
.hero{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:22px}
h1{font-size:clamp(26px,4vw,37px);margin:0 0 7px;line-height:1.2}
.subtitle{color:var(--muted);margin:0;font-size:13px}
.refresh{background:transparent;padding:10px 15px}
.tabs{display:flex;gap:7px;border-bottom:1px solid var(--line);padding-bottom:15px;margin-bottom:18px}
.tab{flex:1;background:transparent;font-weight:750}.tab.active{background:var(--green);color:#09291a;border-color:var(--green)}
.filters{display:grid;grid-template-columns:1fr 1.2fr;gap:12px}
label{font-size:11px;color:var(--muted)}input,select{display:block;width:100%;padding:12px;margin-top:5px}
.meta{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:11px;margin:17px 0}
.notice{padding:12px;border:1px solid #4b5738;border-radius:10px;background:#243021;color:#ead591;font-size:12px;margin-bottom:15px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 335px;gap:20px;align-items:start}
.league-heading{padding:13px 2px 9px;font-weight:750;font-size:13px;color:#c0d7cc}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:10px}
.card-meta{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--muted);margin-bottom:12px}.live{color:var(--red);font-weight:800}
.match-body{display:grid;grid-template-columns:minmax(0,1fr) 240px;align-items:center;gap:15px}
.team{display:flex;gap:9px;align-items:center;margin:8px 0;font-weight:650;overflow-wrap:anywhere}
.crest{display:grid;place-items:center;background:#294237;color:var(--green);width:27px;height:29px;border-radius:7px;font-size:10px;flex-shrink:0}
.score{margin-left:auto;color:var(--green)}
.prices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
.odd{padding:8px 5px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:63px}
.odd span{font-size:10px;color:var(--muted)}.odd strong{font-size:15px}.odd small{font-size:9px;color:var(--muted)}
.odd.selected{background:#254d38;border-color:var(--green)}.odd.selected strong{color:var(--green)}
details{margin-top:10px}summary{cursor:pointer;padding:7px 0;font-size:12px;color:var(--muted)}
.market-title{font-size:11px;color:var(--muted);margin:12px 0 6px}
.market-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
.market-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.slip{position:sticky;top:18px;background:var(--panel);border:1px solid var(--line);border-radius:15px;overflow:hidden}
.slip-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid var(--line)}
.slip-head h2{font-size:17px;margin:0}.badge{background:var(--green);color:#08291a;border-radius:5px;padding:3px 7px;font-size:11px;margin-left:6px}
.slip-body{padding:17px}.mode{font-size:10px;color:var(--green);font-weight:800;letter-spacing:1px;margin-bottom:12px}
.selection{position:relative;border-bottom:1px solid var(--line);padding:11px 25px 11px 0}
.selection strong{font-size:12px;display:block}.selection p{font-size:11px;color:var(--muted);margin:4px 0}
.selection .quote{color:var(--green)}.remove{position:absolute;right:0;top:6px;background:transparent;border:0;font-size:20px}
#stake{font-size:18px;font-weight:700}.stake-label{display:block;margin-top:16px}
.quick{display:flex;gap:6px;margin-top:8px}.quick button{flex:1;font-size:11px;min-height:34px}
.totals{margin:17px 0}.total{display:flex;justify-content:space-between;align-items:center;margin:8px 0;font-size:12px;color:var(--muted)}
.total.win strong{color:var(--green);font-size:24px}.place{width:100%;padding:12px;background:var(--green);color:#08291a;font-weight:850;border:0}
.clear{width:100%;background:transparent;border:0;font-size:11px;color:var(--muted);margin-top:5px}
.disclaimer{font-size:10px;color:var(--muted);margin-top:15px}
#bet-message{font-size:12px}.error{color:var(--red)!important}
.history{border-top:1px solid var(--line);margin-top:18px;padding-top:12px}.history h3{font-size:12px;margin:0 0 8px}
.history-item{border-top:1px solid var(--line);padding:9px 0;font-size:11px;color:var(--muted)}.history-item strong{display:block;color:var(--text)}
.empty{text-align:center;padding:50px 18px;border:1px dashed var(--line);border-radius:13px;color:var(--muted)}
.close,.mobile-bar,.backdrop{display:none}footer{font-size:11px;color:var(--muted);margin-top:25px}
@media(max-width:1000px){.layout{grid-template-columns:minmax(0,1fr) 300px;gap:13px}.match-body{grid-template-columns:1fr}}
@media(max-width:760px){
 main{padding:20px 14px calc(95px + env(safe-area-inset-bottom))}.layout{display:block}.filters{grid-template-columns:1fr}
 .match-body{grid-template-columns:minmax(0,1fr) 165px;gap:10px}.team{font-size:12px}.card{padding:13px}
 .slip{display:none;position:fixed;inset:auto 0 0;z-index:30;max-height:88dvh;overflow:auto;border-radius:20px 20px 0 0;padding-bottom:env(safe-area-inset-bottom)}
 body.open .slip{display:block}body.open{overflow:hidden}.close{display:block;background:transparent;border:0;font-size:22px}
 .mobile-bar{display:flex;justify-content:space-between;align-items:center;position:fixed;inset:auto 0 0;z-index:20;width:100%;border-radius:0;background:#123326;padding:14px 18px calc(14px + env(safe-area-inset-bottom));font-weight:800}
 .mobile-bar small{color:var(--green)}.backdrop{position:fixed;inset:0;background:#0009;z-index:25}body.open .backdrop{display:block}
 .meta{font-size:10px}
}
@media(max-width:390px){.match-body{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div class="header-inner">
 <div class="brand">matchday<span>.</span></div>
 <div class="wallet"><small>DEMO BALANCE</small><strong id="balance">Loading…</strong></div>
</div></header>
<main>
 <section class="hero"><div><h1>Football. All the action.</h1>
 <p class="subtitle">Live and pre-match demo markets · Addis Ababa time</p></div>
 <button class="refresh" id="refresh" type="button">↻ Refresh</button></section>
 <nav class="tabs" aria-label="Schedule">
 <button class="tab" data-tab="live" type="button">● Live</button>
 <button class="tab active" data-tab="today" type="button">Today</button>
 <button class="tab" data-tab="tomorrow" type="button">Tomorrow</button>
 <button class="tab" data-tab="all" type="button">All</button>
 </nav>
 <div class="filters">
 <label>LEAGUE<select id="league"><option value="">All Leagues</option></select></label>
 <label>SEARCH<input id="search" type="search" placeholder="Team or league…" autocomplete="off"></label>
 </div>
 <div class="meta"><span id="summary">Loading matches…</span><span id="updated"></span></div>
 <div class="notice" id="notice" role="status" aria-live="polite" hidden></div>
 <div class="layout">
 <section id="matches" aria-label="Football matches" aria-busy="true"></section>
 <aside class="slip" aria-label="Bet slip">
 <div class="slip-head"><h2>Bet slip <span class="badge" id="count">0</span></h2>
 <button class="close" id="close" type="button" aria-label="Close bet slip">×</button></div>
 <div class="slip-body">
 <div class="mode" id="mode">SINGLE / COMBO</div>
 <p class="subtitle" id="empty-slip">Select an odd to build your demo bet.</p>
 <div id="selections"></div>
 <form id="bet-form" hidden>
 <label class="stake-label">STAKE · DEMO CREDITS
 <input id="stake" type="number" min="1" max="1000" step="0.01" value="10" inputmode="decimal" required></label>
 <div class="quick"><button type="button" data-stake="10">10</button><button type="button" data-stake="25">25</button><button type="button" data-stake="50">50</button><button type="button" data-stake="100">100</button></div>
 <div class="totals"><div class="total"><span>Combined odds</span><strong id="combined">0.00</strong></div>
 <div class="total win"><span>Potential return</span><strong id="potential">0.00</strong></div></div>
 <button class="place" id="place" type="submit">Place demo bet</button>
 <button class="clear" id="clear" type="button">Clear slip</button>
 </form>
 <p id="bet-message" role="status" aria-live="polite"></p>
 <p class="disclaimer">Demo credits only. “Demo” prices are illustrative fallbacks. Live demo selections are enabled. Closed matches cannot accept bets. One selection per match in combos.</p>
 <section class="history"><h3>Recent demo bets</h3><div id="history">No bets yet.</div></section>
 </div></aside>
 </div>
 <footer>All displays today and tomorrow. No real-money betting. Demo wallets reset on restart; bets are not automatically settled.</footer>
</main>
<div class="backdrop" id="backdrop"></div>
<button class="mobile-bar" id="open" type="button"><span>Bet slip · <span id="mobile-count">0</span></span><small id="mobile-return">Choose your matches ↑</small></button>
<script>
"use strict";
const $=id=>document.getElementById(id);
const state={
 tab:"today",events:[],markets:{},slip:new Map(),versions:new Map(),
 csrf:"",bets:[],loading:false,submitting:false,generation:0,attempt:null
};
const clock=new Intl.DateTimeFormat("en-GB",{
 timeZone:"Africa/Addis_Ababa",hour:"2-digit",minute:"2-digit"
});
function today(){
 const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{
 timeZone:"Africa/Addis_Ababa",year:"numeric",month:"2-digit",day:"2-digit"
 }).formatToParts(new Date()).map(x=>[x.type,x.value]));
 return p.year+"-"+p.month+"-"+p.day;
}
function tomorrow(){
 const d=new Date(today()+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+1);
 return d.toISOString().slice(0,10);
}
function el(tag,cls,content){
 const n=document.createElement(tag);if(cls)n.className=cls;
 if(content!==undefined)n.textContent=content;return n;
}
function message(id,value,error=false){
 $(id).textContent=value;$(id).hidden=!value;
 $(id).classList.toggle("error",error);
}
async function api(url,options={}){
 const r=await fetch(url,{
 credentials:"same-origin",...options,
 headers:{Accept:"application/json",...options.headers},
 signal:AbortSignal.timeout(65000)
 });
 let data;try{data=await r.json();}catch{throw new Error("Invalid server response.");}
 if(!r.ok||!data.success)throw new Error(data.error||"Request failed.");
 return data;
}
function wallet(w){$("balance").textContent=w.balance.toFixed(2)+" credits";}
function combined(){return [...state.slip.values()].reduce((n,s)=>n*s.quote.value,1);}
function potential(){return Math.round((Number($("stake").value)||0)*100*combined())/100;}
function renderHistory(){
 $("history").replaceChildren();
 if(!state.bets.length){$("history").textContent="No bets yet.";return;}
 for(const b of state.bets.slice(0,5)){
 const n=el("div","history-item");
 n.append(el("strong","",b.type.toUpperCase()+" · "+b.selections.length+" selection(s)"),
 el("div","","Stake "+b.stake.toFixed(2)+" · Return "+b.potentialReturn.toFixed(2)),
 el("div","","Pending demo bet"));$("history").append(n);
 }
}
function renderSlip(){
 const count=state.slip.size;
 $("count").textContent=count;$("mobile-count").textContent=count;
 $("mode").textContent=count>1?"COMBO · "+count+" MATCHES":"SINGLE BET";
 $("empty-slip").hidden=!!count;$("bet-form").hidden=!count;
 $("selections").replaceChildren();
 for(const [id,s] of state.slip){
 const n=el("div","selection");
 const market=state.markets[s.market];
 const remove=el("button","remove","×");remove.type="button";
 remove.setAttribute("aria-label","Remove "+s.event.home+" selection");
 remove.disabled=state.submitting;
 remove.onclick=()=>{
 state.slip.delete(id);state.versions.set(id,(state.versions.get(id)||0)+1);
 state.attempt=null;renderSlip();renderMatches();
 };
 n.append(el("strong","",s.event.home+" vs "+s.event.away),
 el("p","",market.group+": "+market.label),
 el("p","quote",s.quote.value.toFixed(2)+" · "+(s.quote.source==="demo"?"Demo price":"Provider price")),
 remove);$("selections").append(n);
 }
 $("combined").textContent=count?combined().toFixed(2):"0.00";
 $("potential").textContent=count?potential().toFixed(2):"0.00";
 $("mobile-return").textContent=count?"Return "+potential().toFixed(2)+" ↑":"Choose your matches ↑";
 $("place").disabled=state.submitting||!state.csrf;
 $("place").textContent=state.submitting?"Validating…":count>1?"Place demo combo":"Place demo single";
}
async function select(event,market){
 if(state.submitting)return;
 if(state.slip.get(event.id)?.market===market){
 state.slip.delete(event.id);state.versions.set(event.id,(state.versions.get(event.id)||0)+1);
 state.attempt=null;renderSlip();renderMatches();return;
 }
 if(!state.slip.has(event.id)&&state.slip.size>=12){
 message("notice","Maximum twelve matches per combo.",true);return;
 }
 const version=(state.versions.get(event.id)||0)+1;
 state.versions.set(event.id,version);
 state.slip.set(event.id,{event,market,quote:event.odds[market]});
 state.attempt=null;message("bet-message","");renderSlip();renderMatches();
 try{
 const result=await api("/api/events/"+encodeURIComponent(event.id)+"/odds?date="+event.date);
 if(state.versions.get(event.id)!==version||state.submitting)return;
 const selected=state.slip.get(event.id);
 if(!selected||selected.market!==market)return;
 event.odds=result.odds;selected.quote=result.odds[market];
 state.attempt=null;renderSlip();renderMatches();
 }catch{
 if(state.versions.get(event.id)===version)
 message("bet-message","Price refresh unavailable. Your quote will be checked on placement.");
 }
}
function odd(event,market){
 const quote=event.odds[market];const b=el("button","odd");b.type="button";
 const selected=state.slip.get(event.id)?.market===market;
 b.classList.toggle("selected",selected);b.setAttribute("aria-pressed",String(selected));
 // Live matches are not disabled because their kickoff is in the past.
 b.disabled=state.submitting||!event.bettable||
 (!event.live&&Date.parse(event.startTime)<=Date.now());
 b.append(el("span","",state.markets[market].label),
 el("strong","",quote.value.toFixed(2)),
 el("small","",quote.source==="demo"?"Demo":"Provider"));
 b.onclick=()=>select(event,market);return b;
}
function renderMatches(){
 const root=$("matches");root.replaceChildren();
 const search=$("search").value.trim().toLowerCase();
 const events=state.events.filter(e=>
 (e.home+" "+e.away+" "+e.league).toLowerCase().includes(search)
 );
 $("summary").textContent=events.length+" matches · "+
 (state.tab==="all"?"Today + tomorrow":state.tab==="tomorrow"?tomorrow():today());
 if(!events.length){
 root.append(el("div","empty",state.tab==="live"?"No live matches available.":"No matches found. Try another league or refresh."));
 return;
 }
 const groups=new Map();
 for(const e of events){if(!groups.has(e.league))groups.set(e.league,[]);groups.get(e.league).push(e);}
 for(const [league,matches] of groups){
 root.append(el("div","league-heading",league+" · "+matches.length));
 for(const event of matches){
 const card=el("article","card");const meta=el("div","card-meta");
 meta.append(el("span",event.live?"live":"",
 event.live?"● LIVE · DEMO BETTING":event.status==="closed"?"CLOSED":
 event.date+" · "+clock.format(new Date(event.startTime))),el("span","","FULL TIME"));
 const body=el("div","match-body");const teams=el("div","");
 for(const [side,name]of[["home",event.home],["away",event.away]]){
 const team=el("div","team");
 team.append(el("span","crest",name.slice(0,2).toUpperCase()),el("span","",name));
 if(event.score[side]!==null)team.append(el("span","score",event.score[side]));
 teams.append(team);
 }
 const prices=el("div","prices");
 for(const m of["1","X","2"])prices.append(odd(event,m));
 body.append(teams,prices);
 const details=el("details");details.append(el("summary","","More Markets"));
 const marketGroups=new Map();
 for(const [key,market]of Object.entries(state.markets)){
 if(["1","X","2"].includes(key))continue;
 if(!marketGroups.has(market.group))marketGroups.set(market.group,[]);
 marketGroups.get(market.group).push(key);
 }
 for(const [name,keys]of marketGroups){
 details.append(el("div","market-title",name));
 const grid=el("div","market-grid"+(keys.length===3?" three":""));
 for(const key of keys)grid.append(odd(event,key));
 details.append(grid);
 }
 card.append(meta,body,details);root.append(card);
 }
 }
}
async function load(){
 if(state.loading||state.submitting)return;
 state.loading=true;const generation=state.generation;
 $("refresh").disabled=true;$("matches").setAttribute("aria-busy","true");
 try{
 const date=state.tab==="tomorrow"?tomorrow():today();
 const query=new URLSearchParams({filter:state.tab,date});
 if($("league").value)query.set("league",$("league").value);
 const data=await api("/api/events?"+query);
 if(generation!==state.generation)return;
 state.events=data.events;state.markets=data.markets;
 const selected=$("league").value;$("league").replaceChildren();
 const all=el("option","","All Leagues");all.value="";$("league").append(all);
 for(const league of data.availableLeagues){
 const option=el("option","",league);option.value=league;$("league").append(option);
 }
 $("league").value=data.availableLeagues.includes(selected)?selected:"";
 $("updated").textContent="Updated "+clock.format(new Date(data.updatedAt));
 message("notice",data.warning||"");renderMatches();
 }catch(err){
 if(generation===state.generation){
 message("notice",err.message+" Displayed matches may be outdated.",true);
 if(!state.events.length)$("matches").replaceChildren(el("div","empty","Unable to load matches. Please refresh."));
 }
 }finally{
 state.loading=false;$("refresh").disabled=false;
 $("matches").setAttribute("aria-busy","false");
 if(generation!==state.generation)load();
 }
}
function clear(){
 if(state.submitting)return;
 for(const id of state.slip.keys())state.versions.set(id,(state.versions.get(id)||0)+1);
 state.slip.clear();state.attempt=null;renderSlip();renderMatches();
}
$("bet-form").onsubmit=async event=>{
 event.preventDefault();if(state.submitting||!state.slip.size||!state.csrf)return;
 state.submitting=true;$("stake").disabled=true;
 const payload={stake:Number($("stake").value),selections:[...state.slip.values()].map(s=>({
 eventId:s.event.id,market:s.market,date:s.event.date,quotedOdds:s.quote.value
 }))};
 const fingerprint=JSON.stringify(payload);
 if(state.attempt?.fingerprint!==fingerprint)state.attempt={fingerprint,key:crypto.randomUUID()};
 renderSlip();renderMatches();
 try{
 const data=await api("/api/bet",{method:"POST",headers:{
 "Content-Type":"application/json","X-CSRF-Token":state.csrf,
 "Idempotency-Key":state.attempt.key
 },body:JSON.stringify(payload)});
 wallet(data.wallet);
 if(!state.bets.some(b=>b.id===data.bet.id))state.bets.unshift(data.bet);
 state.slip.clear();state.attempt=null;renderHistory();
 message("bet-message","Demo bet placed successfully.");
 window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
 }catch(err){
 message("bet-message",err.message+" Retrying an unchanged slip will not duplicate an accepted bet.",true);
 }finally{
 state.submitting=false;$("stake").disabled=false;renderSlip();renderMatches();
 }
};
document.querySelectorAll("[data-tab]").forEach(b=>{
 b.setAttribute("aria-pressed",String(b.dataset.tab===state.tab));
 b.onclick=()=>{
 if(state.submitting)return;
 state.tab=b.dataset.tab;state.generation++;state.events=[];$("league").value="";
 document.querySelectorAll("[data-tab]").forEach(tab=>{
 const active=tab.dataset.tab===state.tab;
 tab.classList.toggle("active",active);tab.setAttribute("aria-pressed",String(active));
 });
 $("matches").replaceChildren(el("div","empty","Loading matches…"));load();
 };
});
$("league").onchange=()=>{
 if(state.submitting)return;
 state.generation++;state.events=[];
 $("matches").replaceChildren(el("div","empty","Loading league…"));load();
};
$("search").oninput=renderMatches;
$("refresh").onclick=load;$("clear").onclick=clear;
$("stake").oninput=()=>{state.attempt=null;renderSlip();};
document.querySelectorAll("[data-stake]").forEach(b=>b.onclick=()=>{
 if(state.submitting)return;$("stake").value=b.dataset.stake;
 state.attempt=null;renderSlip();
});
$("open").onclick=()=>document.body.classList.add("open");
const close=()=>document.body.classList.remove("open");
$("close").onclick=close;$("backdrop").onclick=close;
document.addEventListener("keydown",e=>{if(e.key==="Escape")close();});
async function initialize(){
 try{
 const tg=window.Telegram?.WebApp;tg?.ready();tg?.expand();
 tg?.setHeaderColor?.("#123326");tg?.setBackgroundColor?.("#0b1415");
 }catch{}
 try{
 const data=await api("/api/wallet");state.csrf=data.csrfToken;
 state.bets=data.bets;wallet(data.wallet);renderHistory();
 }catch(err){message("bet-message","Wallet unavailable: "+err.message,true);}
 renderSlip();await load();
}
initialize();
setInterval(()=>{if(!document.hidden&&!state.submitting)load();},15000);
</script>
</body>
</html>`;

app.get("/", (req, res) => res.type("html").send(HTML));
app.get("/betting.html", (req, res) => res.type("html").send(HTML));

app.use("/api", (req, res) => {
  res.status(404).json({ success: false, error: "API endpoint not found." });
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("Request failed:", err.message);
  const status = err.type === "entity.parse.failed" ? 400 :
    err.type === "entity.too.large" ? 413 :
    Number.isInteger(err.status) ? err.status : 502;
  res.status(status).json({
    success: false,
    error: err.type === "entity.parse.failed" ? "Invalid JSON." :
      !err.status && status === 502 ? "Provider connection failed. Please retry." : err.message
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
  for (const [key, value] of limits) if (value.expires <= now) limits.delete(key);
  for (const [key, value] of oddsCache) if (now - value.at > 60000) oddsCache.delete(key);
}, 60000).unref();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Matchday demo running on port ${PORT}; timezone=${ZONE}`);
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
});
