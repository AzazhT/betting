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
    success: true,
    wallet: wallet(req.account),
    csrfToken: req.account.csrf,
    bets: req.account.bets
  });
});

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

// Front-end code is integrated below
