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
// Beperking: dekt 18 vaste competities; Europa League/Conference League
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
  // Shrinkage naar het league-gemiddelde: bij weinig gespeelde wedstrijden
  // (begin seizoen) telt een team se eigen cijfers nog nauwelijks mee, zodat
  // één 0-0'tje niet meteen een kansloos-laag verwacht doelaantal oplevert.
  const PRIOR_GAMES = 6;
  const shrink = (sum, played) => (sum + PRIOR_GAMES * avg) / (played + PRIOR_GAMES);
  const homeAtt = shrink(homeStats?.gf ?? 0, homeStats?.played ?? 0);
  const homeDef = shrink(homeStats?.ga ?? 0, homeStats?.played ?? 0);
  const awayAtt = shrink(awayStats?.gf ?? 0, awayStats?.played ?? 0);
  const awayDef = shrink(awayStats?.ga ?? 0, awayStats?.played ?? 0);
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

// Eén speler kan meerdere keren in de gescrapete data voorkomen (bv.
// hoofdcompetitie + Europees kwalificatietoernooi) — dit voegt ze samen tot
// één regel per speler (op playerId, want die is stabiel over competities),
// met opgetelde seizoentotalen, zodat niemand dubbel in een lijst staat.
function mergePlayersByName(players) {
  const byId = new Map();
  for (const p of (players || [])) {
    const key = p.playerId || `${p.name}|${p.team}`;
    if (!byId.has(key)) {
      byId.set(key, { playerId: p.playerId, name: p.name, pos: p.pos, team: p.team, apps: 0, mins: 0, goals: 0, assists: 0, shots: 0, sot: 0, yellowCards: 0, redCards: 0, fouls: 0, corners: 0, tackles: 0, compNames: new Set() });
    }
    const m = byId.get(key);
    m.apps += p.apps || 0; m.mins += p.mins || 0; m.goals += p.goals || 0; m.assists += p.assists || 0;
    m.shots += p.shots || 0; m.sot += p.sot || 0; m.yellowCards += p.yellowCards || 0; m.redCards += p.redCards || 0;
    m.fouls += p.fouls || 0; m.corners += p.corners || 0; m.tackles += p.tackles || 0;
    if (p.compName) m.compNames.add(p.compName);
  }
  return [...byId.values()].map(m => ({
    playerId: m.playerId, name: m.name, pos: m.pos, team: m.team,
    apps: m.apps, mins: m.mins, goals: m.goals, assists: m.assists,
    shots: m.shots, sot: m.sot,
    shotsAvg: m.apps ? +(m.shots / m.apps).toFixed(2) : 0,
    sotAvg: m.apps ? +(m.sot / m.apps).toFixed(2) : 0,
    yellowCards: m.yellowCards, redCards: m.redCards, fouls: m.fouls, corners: m.corners, tackles: m.tackles,
    compName: [...m.compNames].join(' + '),
  }));
}

// ---------- Gedeelde opbouw voor /predict en /predict-multi ----------
function buildMatchBase(match, standings, players) {
  const homeStats = standings.find(t => t.team === match.h);
  const awayStats = standings.find(t => t.team === match.a);
  const model = matchProbabilities(homeStats, awayStats);

  const merged = mergePlayersByName(players);
  const topFor = team => merged
    .filter(p => p.team === team && p.apps >= 1 && p.mins >= 20)
    .sort((a, b) => b.shotsAvg - a.shotsAvg)
    .slice(0, 5)
    .map(p => ({ name: p.name, pos: p.pos, shotsAvg: p.shotsAvg, sotAvg: p.sotAvg, goals: p.goals, assists: p.assists, apps: p.apps, yellowCards: p.yellowCards, redCards: p.redCards, fouls: p.fouls, corners: p.corners }));

  return {
    matchInfo: { apiId: match.apiId, h: match.h, a: match.a, date: match.date, time: match.time, compName: match.compName },
    model: { pHome: model.pHome, pDraw: model.pDraw, pAway: model.pAway },
    homePlayers: topFor(match.h),
    awayPlayers: topFor(match.a),
    homeStanding: homeStats || null,
    awayStanding: awayStats || null,
  };
}

// Onderlinge duels: gewoon uit onze eigen opgebouwde wedstrijdgeschiedenis
// gehaald (geen aparte ESPN-aanroep nodig) — laatste 5, nieuwste eerst.
function computeH2H(allMatches, h, a) {
  return allMatches
    .filter(m => m.finished && m.result && ((m.h === h && m.a === a) || (m.h === a && m.a === h)))
    .sort((x, y) => y.date.localeCompare(x.date))
    .slice(0, 5)
    .map(m => ({ date: m.date, h: m.h, a: m.a, result: m.result, compName: m.compName }));
}

// Scheidsrechter: op aanvraag bij ESPN opgehaald (niet meegescraped, want
// dat zou 1 extra request per wedstrijd × alle competities kosten) en
// permanent gecachet per wedstrijd, want dit verandert nooit meer terug.
async function fetchReferee(env, apiId, compId) {
  const eventId = String(apiId || '').match(/^espn_(\d+)$/)?.[1];
  if (!eventId || !compId) return null;
  const cacheKey = `ref_${eventId}`;
  const cached = await kvGet(env, cacheKey, null);
  if (cached) return cached.name || null;
  try {
    const res = await fetch(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${compId}/events/${eventId}/competitions/${eventId}/officials?lang=en&region=us`);
    const data = await res.json();
    const name = data?.items?.[0]?.displayName || null;
    await kvPut(env, cacheKey, { name });
    return name;
  } catch {
    return null;
  }
}

// Odds: op aanvraag bij ESPN opgehaald (Bet 365 als voorkeur, DraftKings als
// terugval) — niet meegescraped omdat odds continu veranderen en dit alleen
// zinvol is voor de wedstrijd die je daadwerkelijk bekijkt. Kort gecachet
// (10 min) i.p.v. permanent, want de prijs verandert tot de aftrap.
async function fetchOdds(env, apiId, compId) {
  const eventId = String(apiId || '').match(/^espn_(\d+)$/)?.[1];
  if (!eventId || !compId) return null;
  const cacheKey = `odds_${eventId}`;
  const cached = await kvGet(env, cacheKey, null);
  if (cached && (Date.now() - cached.fetchedAt) < 10 * 60 * 1000) return cached.odds;
  try {
    const res = await fetch(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${compId}/events/${eventId}/competitions/${eventId}/odds?lang=en&region=us`);
    const data = await res.json();
    const items = data?.items || [];
    const pick = items.find(i => /bet ?365/i.test(i.provider?.name || '')) || items.find(i => i.provider?.name === 'DraftKings') || items[0];
    const dk = items.find(i => i.provider?.name === 'DraftKings'); // alleen DraftKings heeft overUnder op dit niveau
    let odds = null;
    if (pick?.homeTeamOdds?.odds?.value && pick?.awayTeamOdds?.odds?.value && pick?.drawOdds?.value) {
      odds = {
        provider: pick.provider?.name || 'onbekend',
        home: pick.homeTeamOdds.odds.value,
        draw: pick.drawOdds.value,
        away: pick.awayTeamOdds.odds.value,
        totalLine: dk?.overUnder ?? null,
        overOdds: dk?.overOdds ?? null,
        underOdds: dk?.underOdds ?? null,
      };
    }
    await kvPut(env, cacheKey, { odds, fetchedAt: Date.now() });
    return odds;
  } catch {
    return null;
  }
}

// Speler-props (DraftKings): schoten 1+/2+/3+, schoten-op-doel, anytime
// goalscorer, kaarten — per speler, direct van de bookmaker. Athlete-ID
// wordt uit de $ref-URL gehaald (geen extra fetch nodig) en gekoppeld aan
// onze eigen spelerslijst voor de naam.
const PROP_TYPES = ['Anytime Goalscorer', 'Shots Milestones', 'Shots on Target Milestones', 'To Receive a Card', 'To Receive a Red Card'];
const MATCH_MARKET_TYPES = ['Both Teams To Score', 'Team Total Goals'];

async function fetchPlayerProps(env, apiId, compId, playersByTeam) {
  const eventId = String(apiId || '').match(/^espn_(\d+)$/)?.[1];
  if (!eventId || !compId) return [];
  const cacheKey = `props_${eventId}`;
  const cached = await kvGet(env, cacheKey, null);
  let raw, homeTeamId, awayTeamId;
  if (cached && (Date.now() - cached.fetchedAt) < 10 * 60 * 1000) {
    raw = cached.raw; homeTeamId = cached.homeTeamId; awayTeamId = cached.awayTeamId;
  } else {
    try {
      const oddsRes = await fetch(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${compId}/events/${eventId}/competitions/${eventId}/odds?lang=en&region=us`);
      const oddsData = await oddsRes.json();
      const dk = (oddsData?.items || []).find(i => i.provider?.name === 'DraftKings');
      homeTeamId = dk?.homeTeamOdds?.team?.$ref?.match(/teams\/(\d+)/)?.[1] || null;
      awayTeamId = dk?.awayTeamOdds?.team?.$ref?.match(/teams\/(\d+)/)?.[1] || null;
      const propsRef = dk?.propBets?.$ref;
      if (!propsRef) { raw = []; }
      else {
        const propsRes = await fetch(`${propsRef}&limit=1000`);
        const propsData = await propsRes.json();
        raw = (propsData?.items || [])
          .filter(it => PROP_TYPES.includes(it.type?.name) || MATCH_MARKET_TYPES.includes(it.type?.name))
          .map(it => ({
            athleteId: it.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1],
            teamId: it.team?.$ref?.match(/teams\/(\d+)/)?.[1],
            type: it.type?.name,
            odds: it.current?.over?.value,
            target: it.current?.target?.displayValue,
          }))
          .filter(it => it.odds);
      }
      await kvPut(env, cacheKey, { raw, homeTeamId, awayTeamId, fetchedAt: Date.now() });
    } catch {
      raw = []; homeTeamId = null; awayTeamId = null;
    }
  }

  // Namen koppelen via onze eigen (al opgehaalde) spelerslijst i.p.v. een
  // fetch per speler.
  const nameById = new Map();
  for (const p of playersByTeam) {
    const id = p.playerId?.match(/^espn_\d+_(\d+)$/)?.[1];
    if (id) nameById.set(id, p.name);
  }
  const byPlayer = new Map();
  for (const r of raw) {
    const name = nameById.get(r.athleteId);
    if (!name) continue;
    if (!byPlayer.has(name)) byPlayer.set(name, { name });
    const entry = byPlayer.get(name);
    if (r.type === 'Anytime Goalscorer') entry.anytimeScorer = r.odds;
    else if (r.type === 'Shots Milestones' && r.target === '1+') entry.shots1plus = r.odds;
    else if (r.type === 'Shots on Target Milestones' && r.target === '1+') entry.sot1plus = r.odds;
    else if (r.type === 'To Receive a Card') entry.cardOdds = r.odds;
    else if (r.type === 'To Receive a Red Card') entry.redCardOdds = r.odds;
  }

  // Wedstrijd-brede markten: BTTS (ja/nee) en doelpunten over/under per team
  // (eerste gevonden lijn — DraftKings levert soms meerdere lijnen per team,
  // we pakken gewoon de eerste als "primaire" lijn).
  const bttsItems = raw.filter(r => r.type === 'Both Teams To Score');
  const btts = bttsItems.length >= 2 ? { yes: bttsItems[0].odds, no: bttsItems[1].odds } : null;
  const teamGoalsByTeamId = new Map();
  for (const r of raw) {
    if (r.type !== 'Team Total Goals' || !r.teamId) continue;
    if (!teamGoalsByTeamId.has(r.teamId)) teamGoalsByTeamId.set(r.teamId, { line: r.target, overOdds: r.odds });
  }
  const teamGoals = {
    home: homeTeamId ? teamGoalsByTeamId.get(homeTeamId) || null : null,
    away: awayTeamId ? teamGoalsByTeamId.get(awayTeamId) || null : null,
  };

  return { players: [...byPlayer.values()], btts, teamGoals };
}

function singleMatchPromptBlock(b) {
  const m = b.matchInfo;
  return `Wedstrijd: ${m.h} vs ${m.a} (${m.compName || ''}, ${m.date} ${m.time}).
Modelkansen (Poisson, op basis van eigen vormberekening): thuis ${(b.model.pHome * 100).toFixed(1)}%, gelijk ${(b.model.pDraw * 100).toFixed(1)}%, uit ${(b.model.pAway * 100).toFixed(1)}%.
Spelers met de meeste schoten per wedstrijd bij ${m.h}: ${b.homePlayers.map(p => `${p.name} (${p.shotsAvg}/wedstrijd, ${p.sotAvg} op doel/wedstrijd, ${p.goals} goals, ${p.corners||0} corners, ${p.yellowCards||0} geel/${p.redCards||0} rood, ${p.fouls||0} overtredingen dit seizoen, ${p.apps} wedstrijden gespeeld)`).join(', ') || 'nog geen data'}.
Spelers met de meeste schoten per wedstrijd bij ${m.a}: ${b.awayPlayers.map(p => `${p.name} (${p.shotsAvg}/wedstrijd, ${p.sotAvg} op doel/wedstrijd, ${p.goals} goals, ${p.corners||0} corners, ${p.yellowCards||0} geel/${p.redCards||0} rood, ${p.fouls||0} overtredingen dit seizoen, ${p.apps} wedstrijden gespeeld)`).join(', ') || 'nog geen data'}.`;
}

async function runAi(env, prompt) {
  try {
    const aiResult = await env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
    });
    return extractAiText(aiResult).trim();
  } catch (e) {
    return '';
  }
}

// Namen met diacritics (ø, é, ñ, ...) komen soms dubbel-gecodeerd binnen via
// de GitHub Actions-scrape-pipeline (bv. "Jørgen" -> "JÃ¸rgen") — klassiek
// symptoom van UTF-8-bytes die ergens onderweg als Latin-1 gelezen zijn.
// Round-trip (Latin-1 terug naar bytes, dan als UTF-8 decoderen) herstelt
// dit; strings die al correct waren blijven ongewijzigd (round-trip levert
// dan ongeldige UTF-8 op, dus we vallen terug op het origineel).
function fixMojibake(s) {
  if (typeof s !== 'string' || !/[Â-Ã][-¿]/.test(s)) return s;
  try {
    const repaired = Buffer.from(s, 'latin1').toString('utf8');
    return repaired.includes('�') ? s : repaired;
  } catch {
    return s;
  }
}
function fixMojibakeDeep(val) {
  if (typeof val === 'string') return fixMojibake(val);
  if (Array.isArray(val)) return val.map(fixMojibakeDeep);
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) out[k] = fixMojibakeDeep(val[k]);
    return out;
  }
  return val;
}

// ---------- Refresh: nieuwe scrape-data mergen met opgebouwde geschiedenis ----------
async function ingestEspn(env, body) {
  const now = new Date();
  const incomingMatches = fixMojibakeDeep(Array.isArray(body.matches) ? body.matches : []);
  const incomingPlayers = fixMojibakeDeep(Array.isArray(body.players) ? body.players : []);
  const incomingStandings = fixMojibakeDeep(Array.isArray(body.standings) ? body.standings : []);

  // Wedstrijden mergen op apiId zodat oudere, inmiddels buiten het scrape-
  // venster gevallen wedstrijden (voor vormberekening) bewaard blijven.
  const existing = await kvGet(env, 'espn_matches', { matches: [] });
  const byId = new Map((existing.matches || []).map(m => [m.apiId, m]));
  for (const m of incomingMatches) byId.set(m.apiId, m);
  const matches = [...byId.values()];
  await kvPut(env, 'espn_matches', { matches, updatedAt: now.toISOString() });

  // Officiële stand (punten/GD, van ESPN) heeft voorrang boven onze eigen
  // zelfberekende vorm — die laatste dekt alleen het 20-dagen scrape-
  // venster en is dus minder compleet. Teams zonder officiële stand
  // (competities buiten de prioriteitslijst) vallen terug op computeForm().
  const officialTeams = new Set(incomingStandings.map(s => s.team));
  const fallbackForm = computeForm(matches).filter(f => !officialTeams.has(f.team));
  const standings = [...incomingStandings, ...fallbackForm];
  await kvPut(env, 'espn_standings', { standings, updatedAt: now.toISOString() });

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
      let players = mergePlayersByName(d.players || []);
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
      const [matchesData, standingsData, playersData] = await Promise.all([
        kvGet(env, 'espn_matches', { matches: [] }),
        kvGet(env, 'espn_standings', { standings: [] }),
        kvGet(env, 'espn_players', { players: [] }),
      ]);
      const match = (matchesData.matches || []).find(m => String(m.apiId) === String(apiId));
      if (!match) return json({ error: 'wedstrijd niet gevonden' }, 404);

      const base = buildMatchBase(match, standingsData.standings, playersData.players);
      const fullTable = (standingsData.standings || [])
        .filter(s => s.compName === match.compName)
        .sort((a, b) => a.position - b.position);
      const h2h = computeH2H(matchesData.matches || [], match.h, match.a);
      const relevantPlayers = (playersData.players || []).filter(p => p.team === match.h || p.team === match.a);
      const [referee, odds, propsResult] = await Promise.all([
        fetchReferee(env, match.apiId, match.compId),
        fetchOdds(env, match.apiId, match.compId),
        fetchPlayerProps(env, match.apiId, match.compId, relevantPlayers),
      ]);
      const { players: propsAll, btts, teamGoals } = propsResult;
      const homeNames = new Set(relevantPlayers.filter(p => p.team === match.h).map(p => p.name));
      const props = {
        home: propsAll.filter(p => homeNames.has(p.name)),
        away: propsAll.filter(p => !homeNames.has(p.name)),
      };

      const standingLine = s => s ? `${s.team}: ${s.pts} pt uit ${s.played} (${s.win}-${s.draw}-${s.loss}), doelsaldo ${s.gd >= 0 ? '+' : ''}${s.gd}${s.position ? `, positie ${s.position}` : ''}` : null;
      const h2hLine = h2h.length ? h2h.map(m => `${m.date}: ${m.h} ${m.result} ${m.a}`).join('; ') : 'geen eerdere ontmoetingen bekend';
      const oddsLine = odds ? `Bookmaker-odds (${odds.provider}): thuis ${odds.home}, gelijk ${odds.draw}, uit ${odds.away} (decimaal — lager = grotere favoriet).${odds.totalLine ? ` Totaal doelpunten over/under ${odds.totalLine}: over @${odds.overOdds}, under @${odds.underOdds}.` : ''}` : '';
      const bttsLine = btts ? `Beide teams scoren: ja @${btts.yes}, nee @${btts.no}.` : '';
      const teamGoalsLine = [
        teamGoals.home ? `${match.h} over ${teamGoals.home.line} eigen goals @${teamGoals.home.overOdds}` : null,
        teamGoals.away ? `${match.a} over ${teamGoals.away.line} eigen goals @${teamGoals.away.overOdds}` : null,
      ].filter(Boolean).join(', ');
      const propsLine = propsAll.length
        ? `Speler-odds (DraftKings, decimaal): ${propsAll.slice(0, 10).map(p => `${p.name}${p.anytimeScorer ? ` scoort@${p.anytimeScorer}` : ''}${p.shots1plus ? ` schot1+@${p.shots1plus}` : ''}${p.sot1plus ? ` sot1+@${p.sot1plus}` : ''}${p.cardOdds ? ` kaart@${p.cardOdds}` : ''}`).join(', ')}.`
        : '';
      const prompt = `Je bent een nuchtere voetbalanalist. ${singleMatchPromptBlock(base)}
${[standingLine(base.homeStanding), standingLine(base.awayStanding)].filter(Boolean).join('\n') || 'Geen officiële standdata beschikbaar.'}
Laatste onderlinge duels: ${h2hLine}.
${referee ? `Scheidsrechter: ${referee}.` : ''}
${oddsLine}
${bttsLine}
${teamGoalsLine ? `Doelpunten per team: ${teamGoalsLine}.` : ''}
${propsLine}
Geef in maximaal 6 zinnen Nederlandstalige analyse: wie is favoriet (kijk ook naar de stand, het onderlinge duel-verleden en de bookmaker-odds als die er zijn — is er een value bet, d.w.z. wijkt het model duidelijk af van wat de odds impliceren?), of beide teams waarschijnlijk scoren en hoeveel doelpunten er ongeveer verwacht worden, welke 1-2 spelers interessant zijn voor schoten/doelpunten, en of er spelers opvallen qua corners of kaarten. Wees kritisch — het model is simpel en geen garantie, en de speler-sample kan nog klein zijn.`;
      const analysis = await runAi(env, prompt);

      return json({
        match: base.matchInfo,
        model: base.model,
        players: { home: base.homePlayers, away: base.awayPlayers },
        standings: { home: base.homeStanding, away: base.awayStanding, table: fullTable },
        h2h,
        referee,
        odds,
        btts,
        teamGoals,
        props,
        analysis,
      });
    }

    // Zelfde als /predict maar voor meerdere wedstrijden tegelijk (bv. "wat
    // is mijn beste kans vandaag" over een geselecteerde set) — één
    // gecombineerde AI-analyse die de wedstrijden tegen elkaar afweegt,
    // i.p.v. los per wedstrijd een los verhaaltje.
    if (url.pathname === '/predict-multi') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) return json({ error: 'geen apiId\'s opgegeven (?ids=a,b,c)' }, 400);

      const [matchesData, standingsData, playersData] = await Promise.all([
        kvGet(env, 'espn_matches', { matches: [] }),
        kvGet(env, 'espn_standings', { standings: [] }),
        kvGet(env, 'espn_players', { players: [] }),
      ]);

      const bases = ids
        .map(id => (matchesData.matches || []).find(m => String(m.apiId) === String(id)))
        .filter(Boolean)
        .map(match => buildMatchBase(match, standingsData.standings, playersData.players));

      if (!bases.length) return json({ error: 'geen van de opgegeven wedstrijden gevonden' }, 404);

      const prompt = `Je bent een nuchtere voetbalanalist. Hieronder staan ${bases.length} wedstrijden met modelkansen en topschutters.
${bases.map((b, i) => `${i + 1}. ${singleMatchPromptBlock(b)}`).join('\n')}
Geef een Nederlandstalige analyse (max 6 zinnen): welke 1-2 wedstrijden uit dit lijstje hebben de duidelijkste favoriet, en welke 1-2 spelers uit het geheel zijn het interessantst om op te letten voor schoten/doelpunten. Wees kritisch — het model is simpel en geen garantie.`;
      const analysis = await runAi(env, prompt);

      return json({
        matches: bases.map(b => ({ match: b.matchInfo, model: b.model, players: { home: b.homePlayers, away: b.awayPlayers } })),
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

    // Clublogo's: TheSportsDB (gratis test-key "3") dekt vooral bekende
    // clubs uit de grote competities — lagere divisies/reserveteams/kleinere
    // landen staan er meestal niet in. Wikipedia heeft van vrijwel elke club
    // (ook obscure) een pagina met een logo in de infobox, dus die is de
    // fallback: opensearch vindt de beste paginatitel voor de teamnaam, de
    // page-summary geeft het thumbnail. Resultaat wordt permanent gecachet
    // per team in KV zodat we dit maar één keer per club hoeven te doen.
    if (url.pathname === '/crest') {
      const team = url.searchParams.get('team') || '';
      if (!team) return new Response('', { status: 400 });
      const cacheKey = `crest_${team.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
      let cached = await kvGet(env, cacheKey, null);
      const debug = url.searchParams.get('debug') === '1';
      const dbg = {};
      if (!cached || !cached.badge) {
        let badge = null;
        try {
          const res = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(team)}`, { headers: { 'User-Agent': 'Mozilla/5.0 match-insights-app' } });
          dbg.sdbStatus = res.status;
          const data = await res.json();
          dbg.sdbData = data;
          badge = data?.teams?.[0]?.strBadge || data?.teams?.[0]?.strTeamBadge || null;
        } catch (e) { dbg.sdbError = e.message; }
        if (!badge) {
          try {
            const searchRes = await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(team + ' FC')}&limit=1&format=json`, { headers: { 'User-Agent': 'match-insights-app/1.0 (https://dluca77.github.io/Wk-app/; contact: n/a)' } });
            dbg.wikiSearchStatus = searchRes.status;
            const searchJson = await searchRes.json();
            dbg.wikiSearchJson = searchJson;
            const [, , , urls] = searchJson;
            const pageUrl = urls?.[0];
            const title = pageUrl ? decodeURIComponent(pageUrl.split('/wiki/')[1] || '') : null;
            dbg.wikiTitle = title;
            if (title) {
              const sumRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { headers: { 'User-Agent': 'match-insights-app/1.0 (https://dluca77.github.io/Wk-app/; contact: n/a)' } });
              dbg.wikiSumStatus = sumRes.status;
              const sum = await sumRes.json();
              dbg.wikiSum = sum;
              badge = sum?.thumbnail?.source || sum?.originalimage?.source || null;
            }
          } catch (e) { dbg.wikiError = e.message; }
        }
        cached = { badge, fetchedAt: new Date().toISOString() };
        if (badge) await kvPut(env, cacheKey, cached);
      }
      if (debug) return json({ team, cached, dbg });
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

    return json({ error: 'not found', routes: ['/matches', '/standings', '/players', '/predict', '/predict-multi', '/check-pin', '/visitors', '/crest', '/ingest', '/debug'] }, 404);
  },
};
