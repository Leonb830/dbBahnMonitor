/*
 * Local server: serves the app and proxies the DB timetable data as JSON.
 *
 *   node server.js            -> http://localhost:8000
 *
 * Data source (both speak the same "Timetables" XML format):
 *   - With DB_CLIENT_ID and DB_API_KEY set (environment or .env file): the official DB API Marketplace
 *     Timetables API (https://developers.deutschebahn.com, free registration).
 *   - Otherwise: DB's public IRIS endpoint, which needs no key but is unofficial.
 *
 * GET /api/trains?station=bad-homburg&from=<ms>&to=<ms>
 *   -> { source, trains: [visit, ...] }   (visit shape: see js/data.js)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
try {
  process.loadEnvFile(path.join(ROOT, '.env')); // DB_CLIENT_ID / DB_API_KEY
} catch {
  /* no .env file: fall back to the keyless endpoint */
}
const PORT = Number(process.env.PORT) || 8000;
const MIN = 60000;

// Sources in order of preference; the next one is used when one fails.
const SOURCES = [];
if (process.env.DB_CLIENT_ID && process.env.DB_API_KEY) {
  SOURCES.push({
    name: 'DB Timetables API',
    base: 'https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1',
    headers: { 'DB-Client-Id': process.env.DB_CLIENT_ID, 'DB-Api-Key': process.env.DB_API_KEY, Accept: 'application/xml' },
  });
}
SOURCES.push({ name: 'DB IRIS', base: 'https://iris.noncd.db.de/iris-tts/timetable', headers: { Accept: 'application/xml' } });

const STATIONS = {
  // rightSide: neighbouring stops that lie off the right edge of the map
  'bad-homburg': { eva: '8000712', rightSide: ['Seulberg', 'Friedrichsdorf'] },
};

// ------------------------------------------------------------------ time

const berlinFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function berlinParts(ms) {
  const p = {};
  for (const { type, value } of berlinFmt.formatToParts(new Date(ms))) p[type] = value;
  return p;
}
function berlinOffset(ms) {
  const p = berlinParts(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / MIN) * MIN;
}
/** "YYMMDDHHmm" (German local time) -> epoch ms */
function parseTime(s) {
  if (!s || !/^\d{10}$/.test(s)) return null;
  const [yy, mo, dd, hh, mi] = s.match(/\d\d/g).map(Number);
  const guess = Date.UTC(2000 + yy, mo - 1, dd, hh, mi);
  return guess - berlinOffset(guess - berlinOffset(guess));
}

// ------------------------------------------------------------------- XML

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENT[e]);
function attrs(str) {
  const out = {};
  for (const m of str.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}
/** Parses <s id=..> stops with their <tl>, <ar>, <dp> attributes. */
function parseStops(xml) {
  const stops = new Map();
  for (const m of xml.matchAll(/<s\s([^>]*)>([\s\S]*?)<\/s>/g)) {
    const stop = { id: attrs(m[1]).id };
    for (const tag of ['tl', 'ar', 'dp']) {
      const t = m[2].match(new RegExp(`<${tag}\\s([^>]*?)/?>`));
      if (t) stop[tag] = attrs(t[1]);
    }
    if (stop.id) stops.set(stop.id, stop);
  }
  return stops;
}

// ----------------------------------------------------------------- fetch

const cache = new Map(); // url -> { at, ttl, stops }
async function getStops(source, route, ttl) {
  const url = source.base + route;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.stops;
  const res = await fetch(url, { headers: source.headers, signal: AbortSignal.timeout(12000) });
  if (res.status === 404) {
    cache.set(url, { at: Date.now(), ttl: 10 * MIN, stops: new Map() });
    return new Map();
  }
  if (!res.ok) {
    const why = ((await res.text()).match(/<moreInformation>([^<]*)/) || [])[1];
    throw new Error(`${source.name} answered ${res.status}${why ? ` (${why})` : ''} for ${route}`);
  }
  const stops = parseStops(await res.text());
  cache.set(url, { at: Date.now(), ttl, stops });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return stops;
}

// ------------------------------------------------------------- normalise

const prettyName = (s) => s.replace(/\((Main|M|Taunus)\)/g, ' ').replace(/\s+/g, ' ').trim();

function buildVisits(plan, changes, station) {
  const isRight = (name) => station.rightSide.some((r) => name.startsWith(r));
  const part = (p, c) => {
    if (!p || (c && c.cs === 'c')) return null; // missing or cancelled
    const planned = parseTime(p.pt) ?? parseTime(p.ct); // extra trains only carry the live time
    if (planned == null) return null;
    return {
      planned,
      expected: parseTime(c && c.ct) ?? planned,
      track: (c && c.cp) || p.pp || '',
      path: ((c && c.cpth) || p.ppth || '').split('|').filter(Boolean),
      line: p.l,
    };
  };

  const visits = [];
  // Extra trains put on at short notice only exist in the live changes.
  const stops = [...plan.values()];
  for (const ch of changes.values()) {
    if (!plan.has(ch.id) && ch.tl && (ch.ar || ch.dp)) stops.push(ch);
  }

  for (const stop of stops) {
    const ch = changes.get(stop.id) || {};
    const ar = part(stop.ar, ch.ar);
    const dp = part(stop.dp, ch.dp);
    if (!ar && !dp) continue;
    const tl = stop.tl || {};
    let line = (ar || dp).line;
    if (!line) line = [tl.c, tl.n].filter(Boolean).join(' ');
    else if (/^\d+$/.test(line)) line = (tl.c || '') + line;
    const dirIn = ar ? (ar.path.length && isRight(ar.path[ar.path.length - 1]) ? -1 : 1) : null;
    const dirOut = dp ? (dp.path.length && isRight(dp.path[0]) ? 1 : -1) : null;
    visits.push({
      id: stop.id,
      line,
      type: tl.c === 'S' ? 'sbahn' : 'regio',
      origin: ar && ar.path.length ? prettyName(ar.path[0]) : null,
      destination: dp && dp.path.length ? prettyName(dp.path[dp.path.length - 1]) : null,
      track: parseInt((dp || ar).track, 10) || null,
      dirIn: dirIn ?? dirOut,
      dirOut: dirOut ?? dirIn,
      plannedArrival: ar ? ar.planned : null,
      expectedArrival: ar ? ar.expected : null,
      plannedDeparture: dp ? dp.planned : null,
      expectedDeparture: dp ? dp.expected : null,
    });
  }

  // A train that ends here and the next train that starts from the same track
  // are the same vehicle turning around: merge them into one visit.
  const key = (v) => v.plannedArrival ?? v.plannedDeparture;
  visits.sort((a, b) => key(a) - key(b));
  const lastOnTrack = new Map();
  const merged = [];
  for (const v of visits) {
    const prev = lastOnTrack.get(v.track);
    const turnsAround =
      prev && v.track != null && prev.plannedDeparture == null && v.plannedArrival == null &&
      prev.type === v.type && v.plannedDeparture - prev.plannedArrival <= 60 * MIN;
    if (turnsAround) {
      Object.assign(prev, {
        line: v.line,
        destination: v.destination,
        dirOut: v.dirOut,
        plannedDeparture: v.plannedDeparture,
        expectedDeparture: v.expectedDeparture,
      });
    } else {
      merged.push(v);
      lastOnTrack.set(v.track, v);
    }
  }
  return merged;
}

const lastError = new Map(); // source name -> message, to log each problem once

async function trainsFor(stationId, from, to) {
  const station = STATIONS[stationId];
  if (!station) throw Object.assign(new Error('Unknown station'), { status: 404 });
  to = Math.min(to, from + 8 * 60 * MIN);
  const hours = [];
  for (let t = Math.floor(from / (60 * MIN)) * 60 * MIN; t <= to; t += 60 * MIN) {
    const p = berlinParts(t);
    hours.push(`/plan/${station.eva}/${p.year.slice(2)}${p.month}${p.day}/${p.hour}`);
  }
  let failure;
  for (const source of SOURCES) {
    if (Date.now() < (source.pausedUntil || 0)) continue;
    try {
      const [changes, ...plans] = await Promise.all([
        getStops(source, `/fchg/${station.eva}`, 12000),
        ...hours.map((route) => getStops(source, route, 6 * 60 * MIN)),
      ]);
      const plan = new Map();
      for (const p of plans) for (const [id, s] of p) plan.set(id, s);
      lastError.delete(source.name);
      return { source: source.name, trains: buildVisits(plan, changes, station) };
    } catch (err) {
      failure = err;
      if (SOURCES.length > 1) source.pausedUntil = Date.now() + 10 * MIN; // don't keep asking a source that refuses
      if (lastError.get(source.name) !== err.message) console.error('[api]', err.message);
      lastError.set(source.name, err.message);
    }
  }
  throw failure;
}

// ---------------------------------------------------------------- server

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/trains') {
    try {
      const now = Date.now();
      const from = Number(url.searchParams.get('from')) || now - 60 * MIN;
      const to = Number(url.searchParams.get('to')) || now + 5 * 60 * MIN;
      sendJson(res, 200, await trainsFor(url.searchParams.get('station') || 'bad-homburg', from, to));
    } catch (err) {
      sendJson(res, err.status || 502, { error: err.message });
    }
    return;
  }

  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.)+/, '');
  const file = path.join(ROOT, rel || 'index.html');
  if (!file.startsWith(ROOT + path.sep) || !MIME[path.extname(file)] || path.basename(file).startsWith('.') || path.basename(file) === 'server.js') {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

if (require.main === module) {
  // HOST=0.0.0.0 is needed inside a container; locally the server stays private to this machine.
  server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`Bahnhof Live: http://localhost:${PORT}  (data: ${SOURCES.map((x) => x.name).join(', then ')})`);
  });
}

module.exports = { trainsFor, parseTime, parseStops, buildVisits };
