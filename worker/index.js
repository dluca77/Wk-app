// Football Proxy — Cloudflare Worker
// Databron: "Free API Live Football Data" op RapidAPI
// (v2.football.sportsapipro.com is vervangen — de oude sleutel gaf overal HTTP 401)
//
// Deze API geeft ALLE wedstrijden wereldwijd terug per datum, zonder aparte
// competitie/seizoen-ID's. We halen dus gewoon een reeks datums op (gisteren
// t/m +10 dagen) en cachen alles samen. De frontend filtert/sorteert zelf.

const API_BASE = 'https://free-api-live-football-data.p.rapidapi.com';
const API_HOST = 'free-api-live-football-data.p.rapidapi.com';

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

// ---------- Football API fetch ----------
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

function ymd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ---------- Match mapping ----------
// Voorbeeld van een match-object uit de API:
// { id, leagueId, time:"13.08.2026 21:15", timeTS, home:{id,name,score}, away:{...},
//   statusId, tournamentStage, status:{finished,started,ongoing,scoreStr,utcTime,...} }
function mapMatch(m) {
  const date = m.timeTS ? new Date(m.timeTS) : null;
  const dateStr = date ? date.toISOString().split('T')[0] : '';
  const timeStr = date ? date.toLocaleTimeString('nl-NL', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
  }) : '';
  const st = m.status || {};
  const finished = !!st.finished;
  const live = !!st.started && !finished;
  let result = null;
  if (finished && st.scoreStr) result = st.scoreStr.replace(/\s*-\s*/, '-');
  return {
    apiId: m.id,
    leagueId: m.leagueId,
    h: m.home?.name || m.home?.longName || '',
    a: m.away?.name || m.away?.longName || '',
    date: dateStr,
    time: timeStr,
    result,
    live,
    finished,
    venue: '',
    round: m.tournamentStage ? `Speelronde ${m.tournamentStage}` : '',
  };
}

// ---------- Refresh: alle wedstrijden voor een reeks datums ----------
async function refreshAll(env, { force = false } = {}) {
  const now = new Date();
  const log = [];
  let totalCalls = 0;
  const MAX_CALLS = 20; // 1 call per dag in de range

  const meta = await kvGet(env, 'meta_global', {});
  const stale = force || !meta.lastRun || (now - new Date(meta.lastRun)) > 3 * 60 * 60 * 1000;
  if (!stale) {
    return { ok: true, log: ['skip: nog niet stale'], meta };
  }

  // Van 2 dagen terug tot 10 dagen vooruit
  const existing = await kvGet(env, 'matches_all', { matches: [] });
  const byId = new Map((existing.matches || []).map(m => [m.apiId, m]));

  for (let offset = -2; offset <= 10; offset++) {
    if (totalCalls >= MAX_CALLS) { log.push(`Budget bereikt (${totalCalls}) — rest overgeslagen`); break; }
    const d = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const dateParam = ymd(d);
    try {
      const raw = await apiGet(env, `/football-get-matches-by-date?date=${dateParam}`);
      const matches = raw?.response?.matches || [];
      for (const m of matches) {
        const mapped = mapMatch(m);
        if (mapped.apiId) byId.set(mapped.apiId, mapped);
      }
      log.push(`${dateParam}: ${matches.length} wedstrijden`);
      totalCalls++;
    } catch(e) {
      log.push(`${dateParam} FAIL: ${e.message.slice(0, 80)}`);
    }
  }

  const merged = [...byId.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  await kvPut(env, 'matches_all', { matches: merged, updatedAt: now.toISOString() });

  // Echte marktodds (The Odds API) voor de competities die deze dekt —
  // zonder dit heeft de AI-analyse helemaal niets om op te rekenen.
  if (env.ODDS_API_KEY) {
    try {
      const sports = ['soccer_uefa_champions_league', 'soccer_uefa_europa_league', 'soccer_uefa_europa_conference_league',
                      'soccer_netherlands_eredivisie', 'soccer_epl', 'soccer_spain_la_liga',
                      'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one'];
      const oddsCache = await kvGet(env, 'odds_multi', {});
      const oddsStale = force || !oddsCache.fetchedAt || (now - new Date(oddsCache.fetchedAt)) > 3 * 60 * 60 * 1000;
      if (oddsStale) {
        const allMatches = {};
        for (const sport of sports) {
          try {
            const res = await fetch(
              `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${env.ODDS_API_KEY}`
            );
            if (res.ok) {
              const events = await res.json();
              for (const ev of (Array.isArray(events) ? events : [])) {
                const key = `${ev.home_team}_${ev.away_team}`;
                for (const bm of (ev.bookmakers || [])) {
                  for (const mkt of (bm.markets || [])) {
                    if (!allMatches[key]) allMatches[key] = { h: ev.home_team, a: ev.away_team, sport, odds: {} };
                    if (mkt.key === 'h2h') {
                      const home = mkt.outcomes?.find(o => o.name === ev.home_team);
                      const draw = mkt.outcomes?.find(o => o.name === 'Draw');
                      const away = mkt.outcomes?.find(o => o.name === ev.away_team);
                      if (home && draw && away) allMatches[key].odds['1X2'] = { h: home.price, d: draw.price, a: away.price, bm: bm.title };
                    }
                    if (mkt.key === 'totals') {
                      const o25 = mkt.outcomes?.find(o => o.name === 'Over' && o.point === 2.5);
                      const u25 = mkt.outcomes?.find(o => o.name === 'Under' && o.point === 2.5);
                      if (o25 && u25) allMatches[key].odds['O/U_2.5'] = { over: o25.price, under: u25.price, bm: bm.title };
                    }
                  }
                }
              }
            }
          } catch {}
        }
        oddsCache.matches = allMatches;
        oddsCache.fetchedAt = now.toISOString();
        await kvPut(env, 'odds_multi', oddsCache);
        log.push(`odds_multi: ${Object.keys(allMatches).length} wedstrijden met echte odds`);
      }
    } catch(e) { log.push(`odds_multi FAIL: ${e.message.slice(0, 80)}`); }
  }

  const globalMeta = { lastRun: now.toISOString(), totalCalls, totalMatches: merged.length };
  await kvPut(env, 'meta_global', globalMeta);
  return { ok: true, log, meta: globalMeta };
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

    // Alle wedstrijden (comp-param wordt genegeerd — deze API kent geen aparte competitie-feeds)
    if (url.pathname === '/matches') {
      const d = await kvGet(env, 'matches_all', { matches: [] });
      return json({ matches: d.matches || [], updatedAt: d.updatedAt });
    }

    if (url.pathname === '/comps') return json({});
    if (url.pathname === '/odds') return json(await kvGet(env, 'odds_multi', {}));

    // Standen en spelersdata: geen bevestigde endpoint voor deze API — geeft
    // leeg terug zodat de frontend niet crasht (AI-bet valt terug op odds/vorm).
    if (url.pathname === '/standings') return json({});
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

    if (url.pathname === '/debug') {
      const meta = await kvGet(env, 'meta_global', {});
      const d = await kvGet(env, 'matches_all', { matches: [] });
      return json({ meta, totalMatches: (d.matches || []).length });
    }

    return json({ error: 'not found', routes: ['/matches', '/odds', '/standings', '/player-stats', '/ai-bet', '/check-pin', '/visitors', '/refresh', '/debug'] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env, {}));
  },
};
