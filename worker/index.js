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

    if (url.pathname === '/debug-odds') {
      const apiId = url.searchParams.get('apiId');
      const results = {};
      for (const path of [
        `/matches/get-votes?matchId=${apiId}`,
        `/matches/get-odds?matchId=${apiId}`,
        `/odds/get-match-odds?matchId=${apiId}`,
        `/matches/detail?matchId=${apiId}`,
      ]) {
        try {
          const raw = await apiGet(env, path);
          results[path] = raw;
        } catch (e) {
          results[path] = { error: e.message.slice(0, 200) };
        }
      }
      return json(results);
    }

    if (url.pathname === '/debug') {
      const meta = await kvGet(env, 'meta_global', {});
      const d = await kvGet(env, 'matches_all', { matches: [] });
      const s = await kvGet(env, 'standings_all', { standings: [] });
      return json({ meta, totalMatches: (d.matches || []).length, totalTeamsMetVorm: (s.standings || []).length });
    }

    return json({ error: 'not found', routes: ['/matches', '/comps', '/odds', '/standings', '/player-stats', '/ai-bet', '/check-pin', '/visitors', '/refresh', '/debug'] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env, {}));
  },
};
