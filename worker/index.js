// Football Proxy — Cloudflare Worker
// Databron: Sofascore (via RapidAPI, "Sofascore" by Api Dojo)
// Eerdere bronnen: v2.football.sportsapipro.com (401, sleutel hoort niet bij
// dit account) en free-api-live-football-data (500/maand-limiet al na 1 dag
// testen bereikt, en had sowieso geen bruikbare "alle wedstrijden per dag"
// endpoint — alleen team/toernooi-gebaseerd).
// Sofascore werkt per-competitie/per-seizoen — precies zoals de originele
// (kapotte) databron ooit deed, dus we hergebruiken dezelfde bekende
// tournament-ID's. Eén call per competitie geeft het hele seizoen (heen én
// terug, gespeeld én nog te spelen) — zuinig met het schaarse quotum
// (500/maand op de gratis laag).

const API_BASE = 'https://sofascore.p.rapidapi.com';
const API_HOST = 'sofascore.p.rapidapi.com';

// Bekende Sofascore tournament-ID's
const COMPS = {
  7:     { name: 'Champions League',   flag: '⭐' },
  679:   { name: 'Europa League',      flag: '🟠' },
  17015: { name: 'Conference League',  flag: '🟣' },
  37:    { name: 'Eredivisie',         flag: '🇳🇱' },
  17:    { name: 'Premier League',     flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  8:     { name: 'La Liga',            flag: '🇪🇸' },
  35:    { name: 'Bundesliga',         flag: '🇩🇪' },
  23:    { name: 'Serie A',            flag: '🇮🇹' },
  34:    { name: 'Ligue 1',            flag: '🇫🇷' },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ---------- KV helpers ----------
async function kvGet(env, key, fallback = null) {
  try {
    const val = await env.WK_CACHE.get(key, 'json');
    return val ?? fallback;
  } catch { return fallback; }
}
async function kvPut(env, key, val) {
  try { await env.WK_CACHE.put(key, JSON.stringify(val)); } catch {}
}

// ---------- Sofascore fetch ----------
async function apiGet(env, path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'x-rapidapi-key': env.SPORTSAPI_KEY, 'x-rapidapi-host': API_HOST },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${path} -> HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

// ---------- Season ID discovery (gecached, ~1 week) ----------
async function getSeasonId(env, tournamentId) {
  const meta = await kvGet(env, `meta_${tournamentId}`, {});
  if (meta.seasonId && meta.seasonDiscoveredAt) {
    const age = Date.now() - new Date(meta.seasonDiscoveredAt).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) return meta.seasonId;
  }
  const raw = await apiGet(env, `/tournaments/get-seasons?tournamentId=${tournamentId}`);
  const seasons = raw?.seasons || raw?.data?.seasons || raw || [];
  const list = Array.isArray(seasons) ? seasons : (seasons.seasons || []);
  const now = new Date();
  const currentYear = now.getFullYear();
  const season = list.find(s =>
    String(s.year || s.name || '').includes(String(currentYear))
  ) || list[0];
  if (!season?.id) throw new Error('geen seizoen gevonden');
  meta.seasonId = season.id;
  meta.seasonDiscoveredAt = now.toISOString();
  await kvPut(env, `meta_${tournamentId}`, meta);
  return season.id;
}

// ---------- Match mapping (Sofascore event-shape) ----------
function mapMatch(ev, tournamentId) {
  const h = ev?.homeTeam?.name || ev?.home?.name || '';
  const a = ev?.awayTeam?.name || ev?.away?.name || '';
  const startTime = ev?.startTimestamp;
  const date = startTime ? new Date(startTime * 1000) : null;
  const dateStr = date ? date.toISOString().split('T')[0] : '';
  const timeStr = date ? date.toLocaleTimeString('nl-NL', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
  }) : '';
  const statusType = (ev?.status?.type || '').toLowerCase();
  const finished = statusType === 'finished';
  const live = statusType === 'inprogress';
  let result = null;
  if (finished && ev?.homeScore?.current !== undefined && ev?.awayScore?.current !== undefined) {
    result = `${ev.homeScore.current}-${ev.awayScore.current}`;
  }
  return {
    apiId: ev?.id,
    compId: tournamentId,
    compName: COMPS[tournamentId]?.name,
    compFlag: COMPS[tournamentId]?.flag,
    h, a,
    date: dateStr,
    time: timeStr,
    result,
    live,
    finished,
    venue: ev?.venue?.name || '',
    round: ev?.roundInfo?.round ? `Speelronde ${ev.roundInfo.round}` : '',
  };
}

// ---------- Vorm/statistieken berekenen uit eigen wedstrijddata ----------
function computeForm(matches) {
  const stats = {};
  for (const m of matches) {
    if (!m.finished || !m.result) continue;
    const parts = m.result.split('-').map(Number);
    if (parts.length !== 2 || parts.some(isNaN)) continue;
    const [hs, as] = parts;
    for (const [team, gf, ga] of [[m.h, hs, as], [m.a, as, hs]]) {
      if (!team) continue;
      if (!stats[team]) stats[team] = { team, played: 0, win: 0, draw: 0, loss: 0, gf: 0, ga: 0, pts: 0 };
      const s = stats[team];
      s.played++; s.gf += gf; s.ga += ga;
      if (gf > ga) { s.win++; s.pts += 3; }
      else if (gf === ga) { s.draw++; s.pts += 1; }
      else { s.loss++; }
    }
  }
  return Object.values(stats);
}

// ---------- Refresh: gespeelde (get-matches) + nog te spelen (get-next-matches) ----------
async function refreshAll(env, { force = false } = {}) {
  const now = new Date();
  const log = [];
  let totalCalls = 0;
  const MAX_CALLS = 90;
  const MAX_PAGES_PER_COMP = 4; // tot 120 wedstrijden per richting per competitie (kwalificatierondes CL/EL/ECL kunnen over 30 heen gaan)

  const meta = await kvGet(env, 'meta_global', {});
  const stale = force || !meta.lastRun || (now - new Date(meta.lastRun)) > 12 * 60 * 60 * 1000;
  if (!stale) {
    return { ok: true, log: ['skip: nog niet stale'], meta };
  }

  const byId = new Map();
  for (const tournamentId of Object.keys(COMPS)) {
    if (totalCalls >= MAX_CALLS) { log.push(`Budget bereikt (${totalCalls}) — rest overgeslagen`); break; }
    try {
      const seasonId = await getSeasonId(env, tournamentId);
      totalCalls++;
      let compTotal = 0;
      for (const endpoint of ['get-matches', 'get-next-matches']) {
        for (let page = 0; page < MAX_PAGES_PER_COMP; page++) {
          if (totalCalls >= MAX_CALLS) { log.push(`Budget bereikt tijdens ${COMPS[tournamentId]?.name} — rest overgeslagen`); break; }
          const raw = await apiGet(env, `/tournaments/${endpoint}?tournamentId=${tournamentId}&seasonId=${seasonId}&pageIndex=${page}`);
          totalCalls++;
          const events = raw?.events || raw?.data?.events || [];
          for (const e of events) {
            const m = mapMatch(e, tournamentId);
            byId.set(m.apiId ?? `${m.date}-${m.h}-${m.a}`, m);
          }
          compTotal += events.length;
          if (events.length < 30) break; // laatste pagina bereikt
        }
      }
      log.push(`${COMPS[tournamentId]?.name}: ${compTotal} wedstrijden`);
    } catch(e) {
      log.push(`${tournamentId} FAIL: ${e.message.slice(0, 80)}`);
    }
  }

  const all = [...byId.values()];
  if (all.length) {
    await kvPut(env, 'matches_all', { matches: all, updatedAt: now.toISOString() });
    const form = computeForm(all);
    await kvPut(env, 'standings_all', { standings: form, updatedAt: now.toISOString() });
    log.push(`vorm berekend voor ${form.length} teams`);
  }

  const globalMeta = { lastRun: now.toISOString(), totalCalls, totalMatches: all.length };
  await kvPut(env, 'meta_global', globalMeta);
  return { ok: true, log, meta: globalMeta };
}

// ---------- Odds-scraper (odds1x2.com — gratis, geen API-key) ----------
// Elke competitie heeft een "seed"-wedstrijdpagina op odds1x2.com. Die pagina
// bevat zelf een lijst met alle andere wedstrijden van dezelfde speelronde
// (met hun eigen link), dus we hoeven zelf geen URL-slugs te verzinnen —
// we volgen gewoon de links die de site al aanbiedt.
const ODDS_SOURCE = 'https://www.odds1x2.com';
const ODDS_SEEDS = {
  37: '/football/holland-eredivisie/odds/fc-zwolle-vs-ajax/', // Eredivisie
};
const SCRAPE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function normTeam(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\b(fc|sc|afc|cf|vv)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function fetchOddsPage(path) {
  const res = await fetch(`${ODDS_SOURCE}${path}`, { headers: { 'User-Agent': SCRAPE_UA } });
  if (!res.ok) throw new Error(`odds1x2 ${path} -> HTTP ${res.status}`);
  return res.text();
}

// Haalt de "desktop" odds-tabel (bookmaker-kolommen, thuis/gelijk/uit-rijen) uit een matchpagina.
function parseOddsTable(html) {
  const box = html.match(/odds-table-desktop[\s\S]*?<table class="table table-hover allbets">([\s\S]*?)<\/table>/);
  if (!box) return null;
  const rows = [...box[1].matchAll(/<tr>\s*<td class="titlecard">([^<]+)<\/td>((?:\s*<td[^>]*>\s*<a[^>]*class="allodds[^"]*"[^>]*>([\d.]+)<\/a>\s*<\/td>)+)/g)];
  const parsed = rows.map(r => {
    const label = r[1].trim();
    const vals = [...r[2].matchAll(/>([\d.]+)<\/a>/g)].map(m => parseFloat(m[1]));
    return { label, best: vals.length ? Math.max(...vals) : null, bookmakers: vals.length };
  });
  if (parsed.length !== 3) return null;
  return { home: parsed[0], draw: parsed[1], away: parsed[2] };
}

// De seed-pagina bevat "<li><a href="...">Team A v Team B</a></li>" voor elke
// andere wedstrijd van dezelfde speelronde.
function parseRoundLinks(html) {
  const links = [...html.matchAll(/<li><a href="(\/football\/[^"]+\/odds\/[^"]+)">([^<]+) v ([^<]+)<\/a><\/li>/g)];
  return links.map(m => ({ href: m[1], home: m[2].trim(), away: m[3].trim() }));
}

// Zoek de odds voor een specifieke wedstrijd, cache resultaten in KV om
// odds1x2.com niet onnodig vaak te belasten (rondelijst 6u, odds per match 1u).
async function getOddsForMatch(env, compId, homeTeam, awayTeam) {
  const seed = ODDS_SEEDS[compId];
  if (!seed) return { error: `geen odds-bron gekoppeld voor competitie ${compId}` };

  const roundCacheKey = `oddsround_${compId}`;
  let round = await kvGet(env, roundCacheKey, null);
  if (!round || (Date.now() - new Date(round.fetchedAt).getTime()) > 6 * 60 * 60 * 1000) {
    const seedHtml = await fetchOddsPage(seed);
    round = {
      fetchedAt: new Date().toISOString(),
      links: parseRoundLinks(seedHtml),
      seedHref: seed,
      seedOdds: parseOddsTable(seedHtml),
    };
    await kvPut(env, roundCacheKey, round);
  }

  const nHome = normTeam(homeTeam), nAway = normTeam(awayTeam);
  const isMatch = (h, a) => {
    const lh = normTeam(h), la = normTeam(a);
    return (nHome.includes(lh) || lh.includes(nHome)) && (nAway.includes(la) || la.includes(nAway));
  };

  let targetHref = round.links.find(l => isMatch(l.home, l.away))?.href;
  if (!targetHref && round.seedOdds && isMatch(round.seedOdds.home.label, round.seedOdds.away.label)) {
    return { ...round.seedOdds, source: round.seedHref };
  }
  if (!targetHref) return { error: 'wedstrijd niet gevonden in odds-bron (team-namen komen niet overeen)' };

  const oddsCacheKey = `odds_${targetHref}`;
  let odds = await kvGet(env, oddsCacheKey, null);
  if (!odds || (Date.now() - new Date(odds.fetchedAt || 0).getTime()) > 60 * 60 * 1000) {
    const html = await fetchOddsPage(targetHref);
    const table = parseOddsTable(html);
    if (!table) return { error: 'kon odds-tabel niet lezen op de pagina' };
    odds = { ...table, fetchedAt: new Date().toISOString(), source: targetHref };
    await kvPut(env, oddsCacheKey, odds);
  }
  return odds;
}

// ---------- Eigen kansmodel (Poisson) op basis van computeForm() ----------
function factorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function poissonP(k, lambda) { return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k); }

function matchProbabilities(homeStats, awayStats, leagueAvgGoals = 1.35) {
  const avg = leagueAvgGoals;
  const homeAtt = homeStats?.played ? homeStats.gf / homeStats.played : avg;
  const homeDef = homeStats?.played ? homeStats.ga / homeStats.played : avg;
  const awayAtt = awayStats?.played ? awayStats.gf / awayStats.played : avg;
  const awayDef = awayStats?.played ? awayStats.ga / awayStats.played : avg;
  const lambdaHome = Math.max(0.2, (homeAtt / avg) * (awayDef / avg) * avg * 1.1);
  const lambdaAway = Math.max(0.2, (awayAtt / avg) * (homeDef / avg) * avg * 0.95);

  let pHome = 0, pDraw = 0, pAway = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = poissonP(h, lambdaHome) * poissonP(a, lambdaAway);
      if (h > a) pHome += p; else if (h === a) pDraw += p; else pAway += p;
    }
  }
  return { pHome, pDraw, pAway, lambdaHome, lambdaAway };
}

// ---------- PIN / ADMIN helpers ----------
async function handleCheckPin(req, env) {
  const { pin, deviceId, ua } = await req.json();
  if (!env.PIN_CODE) return json({ error: 'PIN niet geconfigureerd' }, 500);
  const isAdmin = env.ADMIN_PIN && String(pin) === String(env.ADMIN_PIN);
  const isValid = String(pin) === String(env.PIN_CODE) || isAdmin;
  if (!isValid) return json({ ok: false, error: 'Verkeerde pincode' }, 401);
  const u = (ua || '').toLowerCase();
  let device = 'Onbekend'; let browser = '';
  if (u.includes('iphone')) device = 'iPhone'; else if (u.includes('ipad')) device = 'iPad';
  else if (u.includes('samsung')) device = 'Samsung Galaxy'; else if (u.includes('android')) device = 'Android';
  else if (u.includes('mac')) device = 'Mac'; else if (u.includes('windows')) device = 'Windows PC';
  if (u.includes('crios')) browser = 'Chrome iOS'; else if (u.includes('edg/')) browser = 'Edge';
  else if (u.includes('chrome')) browser = 'Chrome'; else if (u.includes('safari') && !u.includes('chrome')) browser = 'Safari';
  const city = req.cf?.city || ''; const country = req.cf?.country || '';
  const location = [city, country].filter(Boolean).join(', ') || 'Onbekend';
  const visitors = await kvGet(env, 'visitors', {});
  const id = deviceId || 'unknown';
  visitors[id] = { lastSeen: new Date().toISOString(), count: (visitors[id]?.count || 0) + 1, device, browser, location, isAdmin };
  await kvPut(env, 'visitors', visitors);
  return json({ ok: true, isAdmin });
}

// ---------- Routes ----------
export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    if (url.pathname === '/matches') {
      const d = await kvGet(env, 'matches_all', { matches: [] });
      return json({ matches: d.matches || [], updatedAt: d.updatedAt });
    }

    if (url.pathname === '/comps') return json(COMPS);
    if (url.pathname === '/odds') return json(await kvGet(env, 'odds_multi', {}));
    if (url.pathname === '/standings') return json(await kvGet(env, 'standings_all', { standings: [] }));
    if (url.pathname === '/player-stats') {
      const wk = await kvGet(env, 'player_stats', {});
      return json(wk);
    }

    if (url.pathname === '/ai-bet') {
      if (req.method === 'GET') return json({ ok: true, key: env.ANTHROPIC_KEY ? 'aanwezig ✓' : 'ONTBREEKT ✗' });
      try {
        const body = await req.json();
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, messages: [{ role: 'user', content: body.prompt }] }),
        });
        return json(await res.json());
      } catch(e) { return json({ error: e.message }, 500); }
    }

    if (url.pathname === '/check-pin' && req.method === 'POST') return handleCheckPin(req, env);

    if (url.pathname === '/visitors') {
      if (url.searchParams.get('key') !== env.REFRESH_SECRET) return json({ error: 'forbidden' }, 403);
      const visitors = await kvGet(env, 'visitors', {});
      const list = Object.entries(visitors).map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
      return json({ total: list.length, visitors: list });
    }

    if (url.pathname === '/refresh') {
      if (url.searchParams.get('key') !== env.REFRESH_SECRET) return json({ error: 'forbidden' }, 403);
      return json(await refreshAll(env, { force: true }));
    }

    if (url.pathname === '/debug-scrape') {
      const target = url.searchParams.get('url');
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const len = parseInt(url.searchParams.get('len') || '3000', 10);
      try {
        const res = await fetch(target, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        });
        const text = await res.text();
        return json({ status: res.status, length: text.length, snippet: text.slice(offset, offset + len) });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (url.pathname === '/value-bet') {
      const apiId = url.searchParams.get('apiId');
      const d = await kvGet(env, 'matches_all', { matches: [] });
      const match = (d.matches || []).find(m => String(m.apiId) === String(apiId));
      if (!match) return json({ error: 'wedstrijd niet gevonden' }, 404);

      const s = await kvGet(env, 'standings_all', { standings: [] });
      const homeStats = s.standings.find(t => t.team === match.h);
      const awayStats = s.standings.find(t => t.team === match.a);
      const model = matchProbabilities(homeStats, awayStats);

      let odds = null;
      try {
        odds = await getOddsForMatch(env, match.compId, match.h, match.a);
      } catch (e) {
        odds = { error: e.message.slice(0, 200) };
      }

      const bets = [];
      if (odds && !odds.error) {
        const checks = [
          { label: match.h, modelProb: model.pHome, odds: odds.home?.best },
          { label: 'Gelijkspel', modelProb: model.pDraw, odds: odds.draw?.best },
          { label: match.a, modelProb: model.pAway, odds: odds.away?.best },
        ];
        for (const c of checks) {
          if (!c.odds) continue;
          const impliedProb = 1 / c.odds;
          const edge = c.modelProb - impliedProb;
          bets.push({ ...c, impliedProb, edge, isValue: edge > 0.05 });
        }
        bets.sort((a, b) => b.edge - a.edge);
      }

      return json({
        match: { apiId: match.apiId, h: match.h, a: match.a, date: match.date, time: match.time, compName: match.compName },
        model: { pHome: model.pHome, pDraw: model.pDraw, pAway: model.pAway },
        odds,
        bets,
      });
    }

    if (url.pathname === '/debug') {
      const meta = await kvGet(env, 'meta_global', {});
      const d = await kvGet(env, 'matches_all', { matches: [] });
      const s = await kvGet(env, 'standings_all', { standings: [] });
      return json({ meta, totalMatches: (d.matches || []).length, totalTeamsMetVorm: (s.standings || []).length });
    }

    return json({ error: 'not found', routes: ['/matches', '/comps', '/odds', '/standings', '/player-stats', '/ai-bet', '/value-bet', '/check-pin', '/visitors', '/refresh', '/debug'] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env, {}));
  },
};
