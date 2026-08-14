// Multi-competitie Football Proxy — Cloudflare Worker
// Ondersteunt: CL, EL, ECL kwalificatie + Eredivisie + top 5 competities
// Budget: 100 calls/dag SportsAPIPro — slim gecached in KV

const API_BASE = 'https://v2.football.sportsapipro.com';

// Competitie config — tournament IDs van SportsAPIPro
// Seizoen IDs worden dynamisch ontdekt en gecached
const COMPS = {
  7:    { name: 'Champions League',      flag: '⭐', group: 'europe' },
  679:  { name: 'Europa League',         flag: '🟠', group: 'europe' },
  17015:{ name: 'Conference League',     flag: '🟣', group: 'europe' },
  37:   { name: 'Eredivisie',            flag: '🇳🇱', group: 'national' },
  17:   { name: 'Premier League',        flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', group: 'national' },
  8:    { name: 'La Liga',               flag: '🇪🇸', group: 'national' },
  35:   { name: 'Bundesliga',            flag: '🇩🇪', group: 'national' },
  23:   { name: 'Serie A',               flag: '🇮🇹', group: 'national' },
  34:   { name: 'Ligue 1',               flag: '🇫🇷', group: 'national' },
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

// ---------- SportsAPIPro fetch ----------
async function apiGet(env, path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'X-RapidAPI-Key': env.SPORTSAPI_KEY, 'X-RapidAPI-Host': 'v2.football.sportsapipro.com' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${path} -> HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

// ---------- Season ID discovery ----------
async function getSeasonId(env, tournamentId) {
  const meta = await kvGet(env, `meta_${tournamentId}`, {});
  if (meta.seasonId && meta.seasonDiscoveredAt) {
    const age = Date.now() - new Date(meta.seasonDiscoveredAt).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) return meta.seasonId; // cache 1 week
  }
  try {
    const raw = await apiGet(env, `/api/tournaments/${tournamentId}/seasons`);
    const seasons = raw?.seasons || raw?.data?.seasons || [];
    const now = new Date();
    const currentYear = now.getFullYear();
    // Zoek huidig seizoen (2026-27 of 2026)
    const season = seasons.find(s =>
      String(s.year||'').includes(String(currentYear)) ||
      String(s.name||'').includes(String(currentYear))
    ) || seasons[seasons.length - 1];
    if (!season) throw new Error('geen seizoen gevonden');
    meta.seasonId = season.id;
    meta.seasonDiscoveredAt = now.toISOString();
    await kvPut(env, `meta_${tournamentId}`, meta);
    return season.id;
  } catch(e) {
    throw new Error(`seasonId ${tournamentId}: ${e.message}`);
  }
}

// ---------- Match mapping ----------
function mapMatch(ev, tournamentId) {
  const h = ev?.homeTeam?.name || ev?.home?.name || '';
  const a = ev?.awayTeam?.name || ev?.away?.name || '';
  const status = ev?.status?.type || ev?.statusType || '';
  const startTime = ev?.startTimestamp || ev?.startTime;
  const date = startTime ? new Date(startTime * 1000) : null;
  const dateStr = date ? date.toISOString().split('T')[0] : '';
  const timeStr = date ? date.toLocaleTimeString('nl-NL', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
  }) : '';
  const finished = ['finished', 'ended', 'ft', 'aet', 'pen'].some(s => status.toLowerCase().includes(s));
  const live = ['inprogress', 'live', '1sthalf', '2ndhalf', 'halftime'].some(s => status.toLowerCase().includes(s));
  let result = null;
  if (ev?.homeScore !== undefined && ev?.awayScore !== undefined) {
    result = `${ev.homeScore.current ?? ev.homeScore}-${ev.awayScore.current ?? ev.awayScore}`;
  } else if (ev?.score) {
    result = ev.score;
  }
  return {
    apiId: ev?.id,
    tournamentId,
    h, a,
    date: dateStr,
    time: timeStr,
    result: finished ? result : null,
    live,
    finished,
    venue: ev?.venue?.name || ev?.venue || '',
    round: ev?.roundInfo?.name || ev?.round || '',
  };
}

// ---------- Refresh per competitie ----------
async function refreshComp(env, tournamentId, log, force = false) {
  const now = new Date();
  const meta = await kvGet(env, `meta_${tournamentId}`, {});

  // Season ID ophalen (gecached)
  let seasonId;
  try { seasonId = await getSeasonId(env, tournamentId); }
  catch(e) { log.push(`${tournamentId} season SKIP: ${e.message.slice(0,60)}`); return 0; }

  let callsUsed = 0;

  // Aankomende wedstrijden (altijd, maar max elke 3u)
  const nextStale = force || !meta.nextAt || (now - new Date(meta.nextAt)) > 3 * 60 * 60 * 1000;
  if (nextStale) {
    try {
      const raw = await apiGet(env, `/api/tournament/${tournamentId}/season/${seasonId}/events/next/0`);
      const events = raw?.events || raw?.data?.events || [];
      const matches = events.map(e => mapMatch(e, tournamentId));
      const existing = await kvGet(env, `matches_${tournamentId}`, { matches: [] });
      // Merge: upcoming vervangt, bestaande finished blijft
      const finished = (existing.matches || []).filter(m => m.finished);
      const seenIds = new Set(finished.map(m => m.apiId));
      const merged = [...finished, ...matches.filter(m => !seenIds.has(m.apiId))];
      await kvPut(env, `matches_${tournamentId}`, { matches: merged, updatedAt: now.toISOString() });
      meta.nextAt = now.toISOString();
      log.push(`${COMPS[tournamentId]?.name}: ${matches.length} aankomend`);
      callsUsed++;
    } catch(e) { log.push(`${tournamentId} next FAIL: ${e.message.slice(0,60)}`); }
  }

  // Gespeelde wedstrijden (elke 6u)
  const lastStale = force || !meta.lastAt || (now - new Date(meta.lastAt)) > 6 * 60 * 60 * 1000;
  if (lastStale) {
    try {
      const raw = await apiGet(env, `/api/tournament/${tournamentId}/season/${seasonId}/events/last/0`);
      const events = raw?.events || raw?.data?.events || [];
      const finished = events.map(e => mapMatch(e, tournamentId)).filter(m => m.finished);
      const existing = await kvGet(env, `matches_${tournamentId}`, { matches: [] });
      const upcoming = (existing.matches || []).filter(m => !m.finished);
      const seenIds = new Set(finished.map(m => m.apiId));
      const merged = [...finished, ...upcoming.filter(m => !seenIds.has(m.apiId))];
      await kvPut(env, `matches_${tournamentId}`, { matches: merged, updatedAt: now.toISOString() });
      meta.lastAt = now.toISOString();
      log.push(`${COMPS[tournamentId]?.name}: ${finished.length} gespeeld`);
      callsUsed++;
    } catch(e) { log.push(`${tournamentId} last FAIL: ${e.message.slice(0,60)}`); }
  }

  // Standen (voor Poisson berekening goals voor/tegen) — elke 6u
  const standingsStale = force || !meta.standingsAt || (now - new Date(meta.standingsAt)) > 6 * 60 * 60 * 1000;
  if (standingsStale && callsUsed < 3) {
    try {
      const raw = await apiGet(env, `/api/tournament/${tournamentId}/season/${seasonId}/standings/total`);
      const rows = raw?.standings?.[0]?.rows || raw?.data?.standings?.[0]?.rows || [];
      const standings = rows.map(r => ({
        team: r.team?.name || '',
        played: r.matches || 0,
        win: r.wins || 0,
        draw: r.draws || 0,
        loss: r.losses || 0,
        gf: r.scoresFor || 0,
        ga: r.scoresAgainst || 0,
        pts: r.points || 0,
      }));
      await kvPut(env, `standings_${tournamentId}`, { standings, updatedAt: now.toISOString() });
      meta.standingsAt = now.toISOString();
      log.push(`${COMPS[tournamentId]?.name} standings: ${standings.length} teams`);
      callsUsed++;
    } catch(e) { log.push(`${tournamentId} standings SKIP: ${e.message.slice(0,60)}`); }
  }

  // Spelersdata van gespeelde wedstrijden — max 2 per run
  const playerStats = await kvGet(env, `player_stats_${tournamentId}`, {});
  const matchData = await kvGet(env, `matches_${tournamentId}`, { matches: [] });
  const finishedMatches = (matchData.matches || []).filter(m => m.finished && m.apiId);
  const processed = new Set(Object.keys(playerStats._processed || {}));
  const toProcess = finishedMatches.filter(m => !processed.has(String(m.apiId))).slice(0, 2);
  let lineupsFetched = 0;
  for (const m of toProcess) {
    if (callsUsed >= 5) break;
    try {
      const raw = await apiGet(env, `/api/match/${m.apiId}/lineups`);
      const mapPlayers = (side, teamName) =>
        (raw?.data?.[side]?.players || []).filter(p => !p.substitute).map(p => {
          const matches2 = 1;
          const xg = p.statistics?.expectedGoals ?? 0;
          const sot = p.statistics?.onTargetScoringAttempt ?? 0;
          const shots = (sot + (p.statistics?.shotOffTarget ?? 0));
          return {
            n: p.player?.name || p.player?.shortName || '?',
            pos: p.position || '?',
            team: teamName,
            matches: 1,
            goals: p.statistics?.goals ?? 0,
            assists: p.statistics?.goalAssist ?? 0,
            shots_total: shots, sot_total: sot,
            xg_total: xg, xgot_total: p.statistics?.expectedGoalsOnTarget ?? 0,
            keyPasses_total: p.statistics?.keyPass ?? 0,
            mins_total: p.statistics?.minutesPlayed ?? 90,
            ratings: p.statistics?.rating ? [p.statistics.rating] : [],
            avg_rating: p.statistics?.rating ?? null,
            avg_xg: xg, avg_shots: shots, avg_sot: sot,
            lastMatchId: m.apiId,
          };
        }).sort((a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0));

      const homeTeam = raw?.data?.home?.team?.name || m.h;
      const awayTeam = raw?.data?.away?.team?.name || m.a;

      // Accumuleer per speler over meerdere wedstrijden
      const merge = (existing, newPlayers) => {
        for (const np of newPlayers) {
          const idx = existing.findIndex(e => e.n === np.n);
          if (idx === -1) { existing.push(np); }
          else {
            const e = existing[idx];
            e.matches = (e.matches || 1) + 1;
            e.goals += np.goals; e.assists += np.assists;
            e.shots_total = (e.shots_total || 0) + np.shots_total;
            e.sot_total = (e.sot_total || 0) + np.sot_total;
            e.xg_total = (e.xg_total || 0) + np.xg_total;
            e.keyPasses_total = (e.keyPasses_total || 0) + np.keyPasses_total;
            e.mins_total = (e.mins_total || 0) + np.mins_total;
            if (np.avg_rating != null) e.ratings = [...(e.ratings || []), np.avg_rating];
            e.avg_rating = e.ratings.length ? Math.round(e.ratings.reduce((a,b)=>a+b,0)/e.ratings.length*10)/10 : null;
            e.avg_xg = Math.round(e.xg_total/e.matches*100)/100;
            e.avg_shots = Math.round(e.shots_total/e.matches*10)/10;
            e.avg_sot = Math.round(e.sot_total/e.matches*10)/10;
            e.lastMatchId = m.apiId;
          }
        }
        return existing.sort((a,b)=>(b.avg_rating??0)-(a.avg_rating??0));
      };

      playerStats[homeTeam] = merge(playerStats[homeTeam] || [], mapPlayers('home', homeTeam));
      playerStats[awayTeam] = merge(playerStats[awayTeam] || [], mapPlayers('away', awayTeam));
      playerStats._processed = playerStats._processed || {};
      playerStats._processed[m.apiId] = now.toISOString();
      lineupsFetched++; callsUsed++;
    } catch(e) { log.push(`lineup ${m.apiId} FAIL: ${e.message.slice(0,50)}`); }
  }
  await kvPut(env, `player_stats_${tournamentId}`, playerStats);
  meta.seasonId = seasonId;
  await kvPut(env, `meta_${tournamentId}`, meta);
  return callsUsed;
}

// ---------- Main refresh ----------
async function refreshAll(env, { force = false } = {}) {
  const now = new Date();
  const log = [];
  let totalCalls = 0;
  const MAX_CALLS = 80; // conservatief budget

  // Haal competities op in volgorde van prioriteit
  // Europa competitions eerst (kwalificaties lopen nu al)
  const priority = [7, 679, 17015, 37, 17, 8, 35, 23, 34];

  for (const id of priority) {
    if (totalCalls >= MAX_CALLS) {
      log.push(`Budget bereikt (${totalCalls} calls) — rest overgeslagen`);
      break;
    }
    try {
      const used = await refreshComp(env, id, log, force);
      totalCalls += used;
    } catch(e) {
      log.push(`${id} CRASH: ${e.message.slice(0,80)}`);
    }
  }

  // Also refresh The Odds API voor aankomende wedstrijden
  if (env.ODDS_API_KEY && totalCalls < MAX_CALLS) {
    try {
      const sports = ['soccer_uefa_champions_league', 'soccer_uefa_europa_league',
                      'soccer_netherlands_eredivisie', 'soccer_epl', 'soccer_spain_la_liga',
                      'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one'];
      const oddsCache = await kvGet(env, 'odds_multi', {});
      const oddsStale = force || !oddsCache.fetchedAt || (now - new Date(oddsCache.fetchedAt)) > 6 * 60 * 60 * 1000;

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
                      if (home && draw && away) allMatches[key].odds['1X2'] = { h: home.price, d: draw.price, a: away.price };
                    }
                    if (mkt.key === 'totals') {
                      const o25 = mkt.outcomes?.find(o => o.name === 'Over' && o.point === 2.5);
                      const u25 = mkt.outcomes?.find(o => o.name === 'Under' && o.point === 2.5);
                      if (o25 && u25) allMatches[key].odds['O/U_2.5'] = { over: o25.price, under: u25.price };
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
        log.push(`odds_multi: ${Object.keys(allMatches).length} wedstrijden`);
      }
    } catch(e) { log.push(`odds_multi FAIL: ${e.message}`); }
  }

  const globalMeta = { lastRun: now.toISOString(), totalCalls };
  await kvPut(env, 'meta_global', globalMeta);
  return { ok: true, log, meta: globalMeta };
}

// ---------- PIN / ADMIN / AI helpers ----------
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

    // Alle matches voor een competitie (of alle)
    if (url.pathname === '/matches') {
      const comp = url.searchParams.get('comp');
      if (comp && COMPS[comp]) {
        const d = await kvGet(env, `matches_${comp}`, { matches: [] });
        const matches = (d.matches || []).map(m => ({
          ...m,
          compId: parseInt(comp),
          compName: COMPS[comp].name,
          compFlag: COMPS[comp].flag,
        }));
        return json({ matches, updatedAt: d.updatedAt });
      }
      // Alle competities samenvoegen
      const all = [];
      for (const id of Object.keys(COMPS)) {
        const d = await kvGet(env, `matches_${id}`, { matches: [] });
        (d.matches || []).forEach(m => { m.compId = parseInt(id); m.compName = COMPS[id].name; m.compFlag = COMPS[id].flag; all.push(m); });
      }
      all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return json({ matches: all, updatedAt: new Date().toISOString() });
    }

    if (url.pathname === '/comps') return json(COMPS);
    if (url.pathname === '/odds') return json(await kvGet(env, 'odds_multi', {}));

    // Standen per competitie of alle
    if (url.pathname === '/standings') {
      const comp = url.searchParams.get('comp');
      if (comp) return json(await kvGet(env, `standings_${comp}`, { standings: [] }));
      const all = {};
      for (const id of Object.keys(COMPS)) {
        const d = await kvGet(env, `standings_${id}`, null);
        if (d) all[id] = d;
      }
      return json(all);
    }

    // Spelersdata per competitie of globaal (WK legacy)
    if (url.pathname === '/player-stats') {
      const comp = url.searchParams.get('comp');
      if (comp) return json(await kvGet(env, `player_stats_${comp}`, {}));
      // Merge alle competities
      const merged = {};
      for (const id of Object.keys(COMPS)) {
        const d = await kvGet(env, `player_stats_${id}`, {});
        Object.assign(merged, d);
      }
      // Voeg WK data toe
      const wk = await kvGet(env, 'player_stats', {});
      Object.assign(merged, wk);
      return json(merged);
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
      const compMeta = {};
      for (const id of Object.keys(COMPS)) compMeta[id] = await kvGet(env, `meta_${id}`, {});
      return json({ meta, compMeta });
    }

    return json({ error: 'not found', routes: ['/matches', '/matches?comp=7', '/comps', '/odds', '/player-stats', '/ai-bet', '/check-pin', '/visitors', '/refresh', '/debug'] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env, {}));
  },
};
