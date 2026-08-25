// Football Proxy — Cloudflare Worker
// Databron: uitsluitend ESPN's onofficiële "core" API
// (sports.core.api.espn.com) — geen API-key, geen quotum, en (anders dan
// Stats Perform's Opta-widget) gewoon bereikbaar vanuit GitHub Actions
// zonder botdetectie-blokkade. Levert wedstrijdschema's/uitslagen én
// per-speler seizoenstotalen (goals, assists, schoten, schoten-op-doel).
// Geen odds, geen xG — de app toont daarom geen odds/value-bets, alleen:
// - Winkans per team (eigen Poisson-model op basis van opgebouwde vorm)
// - Spelersvoorspellingen: schoten/schoten-op-doel per 90 min, dit seizoen
//
// Beperking: dekt 9 vaste competities; Europa League/Conference League
// tonen (nog) geen teams zolang ESPN de groepsfase niet heeft opgezet, en
// spelersstats van een net gestarte competitie kunnen leeg zijn totdat er
// wedstrijden gespeeld zijn — vult zichzelf organisch aan.
//
// Scraping gebeurt in GitHub Actions (.github/workflows/scrape-espn.yml),
// niet in deze Worker zelf, via POST /ingest.

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

function extractAiText(aiResult) {
  const r = aiResult?.response;
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) {
    return r.map(p => (typeof p === 'string' ? p : (p?.response ?? p?.text ?? p?.generated_text ?? ''))).join('');
  }
  if (r && typeof r === 'object') return r.response ?? r.text ?? r.generated_text ?? '';
  return '';
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

// ---------- Refresh: nieuwe scrape-data mergen met opgebouwde geschiedenis ----------
async function ingestEspn(env, body) {
  const now = new Date();
  const incomingMatches = Array.isArray(body.matches) ? body.matches : [];
  const incomingPlayers = Array.isArray(body.players) ? body.players : [];

  // Wedstrijden mergen op apiId zodat oudere, inmiddels buiten het scrape-
  // venster gevallen wedstrijden (voor vormberekening) bewaard blijven.
  const existing = await kvGet(env, 'espn_matches', { matches: [] });
  const byId = new Map((existing.matches || []).map(m => [m.apiId, m]));
  for (const m of incomingMatches) byId.set(m.apiId, m);
  const matches = [...byId.values()];
  await kvPut(env, 'espn_matches', { matches, updatedAt: now.toISOString() });

  const form = computeForm(matches);
  await kvPut(env, 'espn_standings', { standings: form, updatedAt: now.toISOString() });

  // Spelers zijn al season-cumulatieve totalen (ESPN levert dat direct) —
  // gewoon overschrijven, geen eigen opstapeling nodig.
  await kvPut(env, 'espn_players', { players: incomingPlayers, updatedAt: now.toISOString() });

  await kvPut(env, 'meta_espn', { lastRun: now.toISOString(), totalMatches: matches.length, totalPlayers: incomingPlayers.length });
  return { ok: true, matches: matches.length, players: incomingPlayers.length };
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
      const d = await kvGet(env, 'espn_matches', { matches: [] });
      return json({ matches: d.matches || [], updatedAt: d.updatedAt });
    }

    if (url.pathname === '/standings') return json(await kvGet(env, 'espn_standings', { standings: [] }));

    if (url.pathname === '/players') {
      const d = await kvGet(env, 'espn_players', { players: [] });
      let players = d.players || [];
      const q = url.searchParams.get('q');
      if (q) players = players.filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
      const team = url.searchParams.get('team');
      if (team) players = players.filter(p => p.team.toLowerCase() === team.toLowerCase());
      const id = url.searchParams.get('id');
      if (id) {
        const p = players.find(p => p.playerId === id);
        if (!p) return json({ error: 'not found' }, 404);
        return json(p);
      }
      return json({ players, updatedAt: d.updatedAt });
    }

    // Kansmodel (Poisson) + top spelersvoorspellingen (schoten/schoten-op-
    // doel per 90 min, dit seizoen) + Workers AI leesbare analyse. Geen
    // odds — deze databron levert die niet.
    if (url.pathname === '/predict') {
      const apiId = url.searchParams.get('apiId');
      const d = await kvGet(env, 'espn_matches', { matches: [] });
      const match = (d.matches || []).find(m => String(m.apiId) === String(apiId));
      if (!match) return json({ error: 'wedstrijd niet gevonden' }, 404);

      const s = await kvGet(env, 'espn_standings', { standings: [] });
      const homeStats = s.standings.find(t => t.team === match.h);
      const awayStats = s.standings.find(t => t.team === match.a);
      const model = matchProbabilities(homeStats, awayStats);

      const pd = await kvGet(env, 'espn_players', { players: [] });
      const topFor = team => (pd.players || [])
        .filter(p => p.team === team && p.apps >= 2)
        .sort((a, b) => b.shots90 - a.shots90)
        .slice(0, 5)
        .map(p => ({ name: p.name, pos: p.pos, shots90: p.shots90, sot90: p.sot90, goals: p.goals, assists: p.assists, apps: p.apps }));

      const homePlayers = topFor(match.h);
      const awayPlayers = topFor(match.a);

      const prompt = `Je bent een nuchtere voetbalanalist. Wedstrijd: ${match.h} vs ${match.a} (${match.compName || ''}, ${match.date} ${match.time}).
Modelkansen (Poisson, op basis van eigen vormberekening): thuis ${(model.pHome * 100).toFixed(1)}%, gelijk ${(model.pDraw * 100).toFixed(1)}%, uit ${(model.pAway * 100).toFixed(1)}%.
Spelers met de meeste schoten per 90 min bij ${match.h}: ${homePlayers.map(p => `${p.name} (${p.shots90}/90, ${p.sot90} op doel/90, ${p.goals} goals dit seizoen)`).join(', ') || 'nog geen data'}.
Spelers met de meeste schoten per 90 min bij ${match.a}: ${awayPlayers.map(p => `${p.name} (${p.shots90}/90, ${p.sot90} op doel/90, ${p.goals} goals dit seizoen)`).join(', ') || 'nog geen data'}.
Geef in maximaal 4 zinnen Nederlandstalige analyse: wie is favoriet, en welke 1-2 spelers zijn interessant om op te letten voor schoten/doelpunten. Wees kritisch — het model is simpel en geen garantie, en de speler-sample kan nog klein zijn.`;

      let analysis = '';
      try {
        const aiResult = await env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
          messages: [{ role: 'user', content: prompt }],
        });
        analysis = extractAiText(aiResult).trim();
      } catch (e) {
        analysis = '';
      }

      return json({
        match: { apiId: match.apiId, h: match.h, a: match.a, date: match.date, time: match.time, compName: match.compName },
        model: { pHome: model.pHome, pDraw: model.pDraw, pAway: model.pAway },
        players: { home: homePlayers, away: awayPlayers },
        analysis,
      });
    }

    if (url.pathname === '/check-pin' && req.method === 'POST') return handleCheckPin(req, env);

    if (url.pathname === '/visitors') {
      if (url.searchParams.get('key') !== env.REFRESH_SECRET) return json({ error: 'forbidden' }, 403);
      const visitors = await kvGet(env, 'visitors', {});
      const list = Object.entries(visitors).map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
      return json({ total: list.length, visitors: list });
    }

    if (url.pathname === '/debug') {
      const meta = await kvGet(env, 'meta_espn', {});
      return json(meta);
    }

    // Clublogo's: gratis, geen API-key nodig via TheSportsDB's publieke
    // test-endpoint (key "3"). We cachen de gevonden badge-URL permanent per
    // team in KV, zodat we TheSportsDB niet steeds opnieuw hoeven te vragen.
    if (url.pathname === '/crest') {
      const team = url.searchParams.get('team') || '';
      if (!team) return new Response('', { status: 400 });
      const cacheKey = `crest_${team.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
      let cached = await kvGet(env, cacheKey, null);
      if (!cached || !cached.badge) {
        try {
          const res = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(team)}`);
          const data = await res.json();
          const badge = data?.teams?.[0]?.strBadge || data?.teams?.[0]?.strTeamBadge || null;
          cached = { badge, fetchedAt: new Date().toISOString() };
          if (badge) await kvPut(env, cacheKey, cached);
        } catch {
          cached = { badge: null };
        }
      }
      if (cached.badge) return Response.redirect(cached.badge, 302);
      return new Response('', { status: 404 });
    }

    // Ontvangt de scrape-resultaten van .github/workflows/scrape-espn.yml
    // (wedstrijden + season-spelersstats).
    if (url.pathname === '/ingest' && req.method === 'POST') {
      if (url.searchParams.get('key') !== env.REFRESH_SECRET) return json({ error: 'forbidden' }, 403);
      try {
        const body = await req.json();
        const result = await ingestEspn(env, body);
        return json(result);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'not found', routes: ['/matches', '/standings', '/players', '/predict', '/check-pin', '/visitors', '/crest', '/ingest', '/debug'] }, 404);
  },
};
