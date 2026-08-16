// Football Proxy — Cloudflare Worker
// Databron: GEEN betaalde/rate-limited API's meer. Alles hieronder is
// zelfgebouwd binnen het Worker-platform:
// - Wedstrijdschema: scraping van odds1x2.com (Eredivisie, Premier League,
//   La Liga, Champions League-kwalificatie — zie scrapeCompFixtures() en
//   ODDS_SEEDS) + betexplorer.com (Bundesliga, Serie A, Ligue 1, Europa
//   League, Conference League — zie scrapeBetExplorerFixtures() en
//   BETEXPLORER_COMPS). Beide gratis, geen API-key, geen quotum.
// - Odds: scraping van odds1x2.com (zelfde bron, dezelfde pagina's).
// - AI-analyse: Cloudflare Workers AI binding (env.AI), ingebouwd in het
//   Workers-platform met een gratis dagelijkse toewijzing — geen losse
//   API-key of abonnement.
//
// Eerdere bronnen die zijn VERWIJDERD omdat ze een betaald/rate-limited
// quotum hadden dat kan opraken: Sofascore via RapidAPI (500 calls/maand,
// geraakt HTTP 429 na een dag testen), the-odds-api.com, en de
// Anthropic API (api.anthropic.com) voor /ai-bet.
//
// Beperking: geen van beide bronnen geeft wedstrijduitslagen, alleen
// aankomend schema. Team-vorm (computeForm) werkt dus pas zodra er zelf
// verzamelde uitslagen zijn — dat groeit vanzelf naarmate het seizoen
// vordert.

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

// Bekende competities. Alleen Eredivisie heeft momenteel een gekoppelde
// gratis scrape-bron voor het wedstrijdschema — zie ODDS_SEEDS.
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

// ---------- Scraper: odds1x2.com (gratis, geen API-key, geen quotum) ----------
// Elke competitie heeft een "seed"-wedstrijdpagina op odds1x2.com. Die
// pagina bevat zelf een lijst met alle andere wedstrijden van dezelfde
// speelronde (met hun eigen link), dus we hoeven geen URL-slugs te
// verzinnen — we volgen gewoon de links die de site al aanbiedt. Elke
// wedstrijdpagina bevat ook een `all-time-event`-blok met de echte
// datum/tijd, bv. "Sunday - 09/08/2026 14:30".
const ODDS_SOURCE = 'https://www.odds1x2.com';
const ODDS_SEEDS = {
  37: '/football/holland-eredivisie/odds/fc-zwolle-vs-ajax/', // Eredivisie
  17: '/football/england-premier-league/odds/newcastle-vs-liverpool/', // Premier League
  8:  '/football/spain-primera-division/odds/atletico-madrid-vs-malaga/', // La Liga
  7:  '/football/champions-league-qual/odds/dinamo-zagreb-vs-viking/', // Champions League (kwalificatieronde — seizoen is nog niet in de groepsfase)
  // Nog geen gratis seed gevonden voor: Europa League (679), Conference
  // League (17015), Bundesliga (35), Serie A (23), Ligue 1 (34) — stonden
  // niet op de odds1x2-homepage op het moment van scrapen.
};
const SCRAPE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function normTeam(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\b(fc|sc|afc|cf|vv|ud|cd|ac)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function fetchOddsPage(path) {
  const res = await fetch(`${ODDS_SOURCE}${path}`, { headers: { 'User-Agent': SCRAPE_UA } });
  if (!res.ok) throw new Error(`odds1x2 ${path} -> HTTP ${res.status}`);
  return res.text();
}

// De statische seeds in ODDS_SEEDS raken na verloop van tijd achterhaald
// (een speelronde is een keer voorbij, de site linkt dan geen sibling-
// wedstrijden meer die nog moeten komen). Om dat op te lossen zoeken we
// elke paar uur op de odds1x2-homepage naar een VERSERE wedstrijd van
// dezelfde competitie (zelfde land/competitie-slug uit het pad) en
// gebruiken die als seed in plaats van de vaste — zonder dat iemand
// handmatig een nieuwe seed-URL hoeft op te zoeken.
async function getCurrentSeed(env, compId) {
  const staticSeed = ODDS_SEEDS[compId];
  if (!staticSeed) return null;
  const slug = staticSeed.match(/^\/football\/([a-z0-9-]+)\/odds\//)?.[1];
  if (!slug) return staticSeed;

  const cacheKey = `seed_${compId}`;
  const cached = await kvGet(env, cacheKey, null);
  if (cached?.seed && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < 6 * 60 * 60 * 1000) {
    return cached.seed;
  }

  try {
    const homeHtml = await fetchOddsPage('/');
    const re = new RegExp(`/football/${slug}/odds/[a-z0-9-]+-vs-[a-z0-9-]+/`, 'g');
    const found = [...new Set(homeHtml.match(re) || [])];
    const seed = found[0] || staticSeed;
    await kvPut(env, cacheKey, { seed, fetchedAt: new Date().toISOString() });
    return seed;
  } catch {
    return staticSeed;
  }
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

// Haalt de echte wedstrijddatum/tijd en teamnamen uit een matchpagina.
// Bron: `<div class="all-time-event">Sunday - 09/08/2026 14:30</div>` en
// `<h1 class="h1Match">FC Zwolle v Ajax Betting Odds</h1>`.
function parseMatchMeta(html) {
  const dateM = html.match(/all-time-event">\w+ - (\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})</);
  let date = '', time = '';
  if (dateM) {
    const [, dd, mm, yyyy, hh, min] = dateM;
    date = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    time = `${hh.padStart(2, '0')}:${min}`;
  }
  const teamsM = html.match(/<h1 class="h1Match">([^<]+?) v ([^<]+?) Betting Odds/);
  return { date, time, home: teamsM?.[1]?.trim() || '', away: teamsM?.[2]?.trim() || '' };
}

// Zoek de odds voor een specifieke wedstrijd, cache resultaten in KV om
// odds1x2.com niet onnodig vaak te belasten (rondelijst 6u, odds per match 1u).
async function getOddsForMatch(env, compId, homeTeam, awayTeam) {
  const seed = await getCurrentSeed(env, compId);
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
      seedMeta: parseMatchMeta(seedHtml),
    };
    await kvPut(env, roundCacheKey, round);
  }

  const nHome = normTeam(homeTeam), nAway = normTeam(awayTeam);
  const isMatch = (h, a) => {
    const lh = normTeam(h), la = normTeam(a);
    return (nHome.includes(lh) || lh.includes(nHome)) && (nAway.includes(la) || la.includes(nAway));
  };

  let targetHref = round.links.find(l => isMatch(l.home, l.away))?.href;
  if (!targetHref && round.seedOdds && isMatch(round.seedMeta?.home, round.seedMeta?.away)) {
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

// Haalt het volledige wedstrijdschema (huidige speelronde) van een
// competitie op via zijn ODDS_SEEDS-ingang: de seed-wedstrijd zelf +
// alle wedstrijden die de seed-pagina als "zelfde speelronde" linkt.
// Geen resultaten (odds1x2 toont alleen aankomende odds, geen scores) —
// alleen datum/tijd/teams. Werkt voor elke compId die in ODDS_SEEDS staat.
async function scrapeCompFixtures(env, compId) {
  const seed = await getCurrentSeed(env, compId);
  if (!seed) return [];
  const seedHtml = await fetchOddsPage(seed);
  const seedMeta = parseMatchMeta(seedHtml);
  const links = parseRoundLinks(seedHtml);
  const targets = [{ href: seed, fallbackHome: seedMeta.home, fallbackAway: seedMeta.away, html: seedHtml }, ...links];

  const matches = [];
  for (const t of targets) {
    try {
      const html = t.html || await fetchOddsPage(t.href);
      const meta = parseMatchMeta(html);
      if (!meta.date) continue;
      const h = meta.home || t.fallbackHome || t.home;
      const a = meta.away || t.fallbackAway || t.away;
      if (!h || !a) continue;
      matches.push({
        apiId: `odds1x2_${t.href}`,
        compId,
        compName: COMPS[compId]?.name,
        compFlag: COMPS[compId]?.flag,
        h, a,
        date: meta.date,
        time: meta.time,
        result: null,
        live: false,
        finished: false,
        venue: '',
        round: '',
        source: 'odds1x2',
      });
    } catch { /* deze wedstrijd overslaan, rest gaat door */ }
  }
  return matches;
}

// ---------- Scraper: betexplorer.com (gratis, geen bot-blokkade aangetroffen) ----------
// Vult de competities aan die odds1x2.com niet toont: Bundesliga, Serie A,
// Ligue 1, Europa League, Conference League. BetExplorer heeft een simpele
// server-gerenderde fixtures-tabel per competitie, geen Cloudflare-uitdaging
// zoals Forebet, en toont ook per-wedstrijd H2H via de "mutual-matches"-pagina.
const BETEXPLORER_SOURCE = 'https://www.betexplorer.com';
const BETEXPLORER_COMPS = {
  35:    'germany/bundesliga',              // Bundesliga
  23:    'italy/serie-a',                   // Serie A
  34:    'france/ligue-1',                  // Ligue 1
  679:   'europe/europa-league',            // Europa League
  17015: 'europe/europa-conference-league', // Conference League
};

async function fetchBetExplorerPage(path) {
  const res = await fetch(`${BETEXPLORER_SOURCE}${path}`, { headers: { 'User-Agent': SCRAPE_UA } });
  if (!res.ok) throw new Error(`betexplorer ${path} -> HTTP ${res.status}`);
  return res.text();
}

// Fixtures-tabel bevat rijen als:
// <td class="table-main__datetime">28.08. 19:30</td>
// <td class="h-text-left"><a href="/football/germany/bundesliga/bayern-munich-vfb-stuttgart/xrtCcyAe/" class="in-match"><span>Bayern Munich</span> - <span>Stuttgart</span></a></td>
// Geen jaartal in de datum — we leiden het af (volgend jaar als de maand al
// >2 maanden "in het verleden" zou liggen t.o.v. vandaag, i.v.m. seizoenen
// die het jaar overschrijden).
function parseBetExplorerFixtures(html, compId) {
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const rows = [...html.matchAll(
    /<td class="table-main__datetime">(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})<\/td>\s*<td class="h-text-left"><a href="(\/football\/[^"]+)" class="in-match"><span>([^<]+)<\/span>\s*-\s*<span>([^<]+)<\/span>/g
  )];
  return rows.map(m => {
    const [, dd, mm, hh, min, href, home, away] = m;
    let year = curYear;
    const candidate = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
    if (candidate.getTime() < now.getTime() - 60 * 24 * 60 * 60 * 1000) year++;
    const date = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    return {
      apiId: `betexplorer_${href}`,
      compId,
      compName: COMPS[compId]?.name,
      compFlag: COMPS[compId]?.flag,
      h: home.trim(), a: away.trim(),
      date, time: `${hh.padStart(2, '0')}:${min}`,
      result: null, live: false, finished: false,
      venue: '', round: '', source: 'betexplorer',
      beHref: href,
    };
  });
}

async function scrapeBetExplorerFixtures(env, compId) {
  const slug = BETEXPLORER_COMPS[compId];
  if (!slug) return [];
  const html = await fetchBetExplorerPage(`/football/${slug}/fixtures/`);
  return parseBetExplorerFixtures(html, compId);
}

// ---------- Scraper: alle wedstrijden vandaag, wereldwijd (betexplorer.com homepage) ----------
// De homepage van betexplorer.com toont (los van de vaste competities
// hierboven) een live "vandaag"-overzicht met ALLE competities/landen door
// elkaar (200+ wedstrijden). Elke competitie-header bevat data-league-name/
// data-country-name, elke wedstrijd een data-ts (unix-timestamp) en
// data-dt="dd,mm,yyyy,hh,mm". Beperking: dit is alleen VANDAAG — voor
// toekomstige dagen zou je dit per competitie moeten herhalen, wat niet
// haalbaar is voor 200+ competities tegelijk zonder een aparte scraper per
// competitie te bouwen (zoals we voor de 9 hoofdcompetities al doen).
const COUNTRY_FLAGS = {
  'England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','Wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿','Spain':'🇪🇸','Germany':'🇩🇪','Italy':'🇮🇹','France':'🇫🇷',
  'Netherlands':'🇳🇱','Portugal':'🇵🇹','Belgium':'🇧🇪','Turkey':'🇹🇷','Greece':'🇬🇷','Austria':'🇦🇹',
  'Switzerland':'🇨🇭','Poland':'🇵🇱','Ukraine':'🇺🇦','Russia':'🇷🇺','Denmark':'🇩🇰','Sweden':'🇸🇪',
  'Norway':'🇳🇴','Finland':'🇫🇮','Croatia':'🇭🇷','Serbia':'🇷🇸','Romania':'🇷🇴','Czech Republic':'🇨🇿',
  'Hungary':'🇭🇺','Bulgaria':'🇧🇬','Slovakia':'🇸🇰','Slovenia':'🇸🇮','Ireland':'🇮🇪','Israel':'🇮🇱',
  'USA':'🇺🇸','Mexico':'🇲🇽','Brazil':'🇧🇷','Argentina':'🇦🇷','Chile':'🇨🇱','Colombia':'🇨🇴','Uruguay':'🇺🇾',
  'Peru':'🇵🇪','Ecuador':'🇪🇨','Paraguay':'🇵🇾','Bolivia':'🇧🇴','Venezuela':'🇻🇪','Japan':'🇯🇵',
  'South Korea':'🇰🇷','China':'🇨🇳','Australia':'🇦🇺','Saudi Arabia':'🇸🇦','Qatar':'🇶🇦','Morocco':'🇲🇦',
  'Egypt':'🇪🇬','South Africa':'🇿🇦','Nigeria':'🇳🇬','Canada':'🇨🇦','Iceland':'🇮🇸',
};
function countryFlag(country) { return COUNTRY_FLAGS[country] || '🌍'; }

function parseGlobalMatches(html) {
  const headers = [];
  const headerRe = /data-league-name="([^"]+)"[^]{0,150}?data-country-name="([^"]+)"/g;
  let hm;
  while ((hm = headerRe.exec(html))) headers.push({ idx: hm.index, league: hm[1], country: hm[2] });

  const matches = [];
  const matchRe = /data-ts="(\d+)"[^]{0,250}?data-dt="(\d+),(\d+),(\d+),(\d+),(\d+)"[^]{0,400}?data-live-cell="time">\s*([^<]*?)\s*<[^]{0,600}?href="(\/football\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/[a-zA-Z0-9]+\/)"[^]{0,600}?participantHome[^>]*>\s*<p[^>]*>([^<]+)<\/p>[^]{0,300}?participantAway[^>]*>[^]{0,250}?<p[^>]*>([^<]+)<\/p>/g;
  let mm;
  while ((mm = matchRe.exec(html))) {
    const idx = mm.index;
    let hdr = null;
    for (const h of headers) { if (h.idx <= idx) hdr = h; else break; }
    const [, , dd, mo, yy, hh, mi, status, href, home, away] = mm;
    const date = `${yy}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const time = `${hh.padStart(2, '0')}:${mi.padStart(2, '0')}`;
    const statusTrim = (status || '').trim();
    const finished = /^FIN/i.test(statusTrim);
    const live = !finished && statusTrim !== '' && !/^\d{1,2}:\d{2}$/.test(statusTrim);
    matches.push({
      apiId: `betexplorer_global_${href}`,
      compId: hdr ? `be_${hdr.country}_${hdr.league}` : 'be_onbekend',
      compName: hdr ? hdr.league : 'Onbekend',
      compFlag: hdr ? countryFlag(hdr.country) : '🌍',
      h: (home || '').trim(), a: (away || '').trim(),
      date, time, result: null, live, finished,
      venue: '', round: '', source: 'betexplorer_global',
    });
  }
  return matches.filter(m => m.h && m.a);
}

async function scrapeGlobalMatches() {
  const res = await fetch('https://www.betexplorer.com/', { headers: { 'User-Agent': SCRAPE_UA } });
  if (!res.ok) throw new Error(`betexplorer homepage -> HTTP ${res.status}`);
  const html = await res.text();
  return parseGlobalMatches(html);
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

// ---------- Refresh ----------
async function refreshAll(env, { force = false } = {}) {
  const now = new Date();
  const log = [];

  const meta = await kvGet(env, 'meta_global', {});
  const stale = force || !meta.lastRun || (now - new Date(meta.lastRun)) > 12 * 60 * 60 * 1000;
  if (!stale) {
    return { ok: true, log: ['skip: nog niet stale'], meta };
  }

  // Begin met de bestaande dataset zodat oude wedstrijden (van de nu
  // verwijderde Sofascore-bron, of andere competities zonder scraper)
  // niet verloren gaan.
  const existing = await kvGet(env, 'matches_all', { matches: [] });
  const byId = new Map((existing.matches || []).map(m => [m.apiId ?? `${m.date}-${m.h}-${m.a}`, m]));

  const scrapedCompIds = Object.keys(ODDS_SEEDS).map(Number);
  for (const compId of scrapedCompIds) {
    try {
      const compMatches = await scrapeCompFixtures(env, compId);
      // Verwijder eerst onze eigen vorige odds1x2-scrape-resultaten van deze
      // competitie, zodat wedstrijden die uit de huidige speelronde zijn
      // verdwenen niet blijven hangen.
      for (const key of [...byId.keys()]) {
        const m = byId.get(key);
        if (m.compId === compId && m.source === 'odds1x2') byId.delete(key);
      }
      let mergedCount = 0, newCount = 0;
      const snapshot = [...byId.entries()]; // vaste snapshot, niet de live Map, om mutatie-tijdens-iteratie-verrassingen te vermijden
      for (const scraped of compMatches) {
        // Zoek een bestaande wedstrijd (bv. bevroren Sofascore-data) met
        // dezelfde teams + datum, zodat we die MERGEN i.p.v. een dubbele
        // kaart toevoegen — en zodat live/uitslag-status (die odds1x2 niet
        // heeft) behouden blijft in plaats van overschreven te worden.
        const nH = normTeam(scraped.h), nA = normTeam(scraped.a);
        let existingKey = null;
        for (const [key, m] of snapshot) {
          if (String(m.compId) !== String(compId) || m.date !== scraped.date) continue;
          if (normTeam(m.h) === nH && normTeam(m.a) === nA) { existingKey = key; break; }
        }
        if (existingKey && byId.has(existingKey)) {
          const old = byId.get(existingKey);
          // Belangrijk: we nemen NIET scraped.source ('odds1x2') over als de
          // oude entry dat niet had. Zou dat wel gebeuren, dan ziet de
          // "verwijder vorige odds1x2-scrape-resultaten"-stap hierboven deze
          // gemergede entry bij de VOLGENDE refresh aan voor een pure
          // scrape-entry en verwijdert 'm — waarna er een nieuwe entry met
          // een andere apiId voor terugkomt en de merge zichzelf ontrafelt.
          byId.set(existingKey, {
            ...scraped,
            apiId: old.apiId,
            source: old.source,
            live: old.live || scraped.live,
            finished: old.finished || scraped.finished,
            result: old.result || scraped.result,
          });
          mergedCount++;
        } else {
          byId.set(scraped.apiId, scraped);
          newCount++;
        }
      }
      log.push(`${COMPS[compId]?.name} (odds1x2-scrape): ${compMatches.length} wedstrijden van de huidige speelronde (${mergedCount} gemerged met bestaande data, ${newCount} nieuw)`);
    } catch (e) {
      log.push(`${COMPS[compId]?.name}-scrape FAIL (oude data behouden): ${e.message.slice(0, 120)}`);
    }
  }

  const beCompIds = Object.keys(BETEXPLORER_COMPS).map(Number);
  for (const compId of beCompIds) {
    try {
      const compMatches = await scrapeBetExplorerFixtures(env, compId);
      for (const key of [...byId.keys()]) {
        const m = byId.get(key);
        if (m.compId === compId && m.source === 'betexplorer') byId.delete(key);
      }
      let mergedCount = 0, newCount = 0;
      const snapshot = [...byId.entries()];
      for (const scraped of compMatches) {
        const nH = normTeam(scraped.h), nA = normTeam(scraped.a);
        let existingKey = null;
        for (const [key, m] of snapshot) {
          if (String(m.compId) !== String(compId) || m.date !== scraped.date) continue;
          if (normTeam(m.h) === nH && normTeam(m.a) === nA) { existingKey = key; break; }
        }
        if (existingKey && byId.has(existingKey)) {
          const old = byId.get(existingKey);
          byId.set(existingKey, {
            ...scraped,
            apiId: old.apiId,
            source: old.source,
            live: old.live || scraped.live,
            finished: old.finished || scraped.finished,
            result: old.result || scraped.result,
          });
          mergedCount++;
        } else {
          byId.set(scraped.apiId, scraped);
          newCount++;
        }
      }
      log.push(`${COMPS[compId]?.name} (betexplorer-scrape): ${compMatches.length} wedstrijden (${mergedCount} gemerged met bestaande data, ${newCount} nieuw)`);
    } catch (e) {
      log.push(`${COMPS[compId]?.name}-scrape FAIL (oude data behouden): ${e.message.slice(0, 120)}`);
    }
  }

  const uncoveredComps = Object.keys(COMPS).map(Number).filter(id => !scrapedCompIds.includes(id) && !beCompIds.includes(id));
  if (uncoveredComps.length) {
    log.push(`Nog geen gratis scrape-bron gekoppeld voor: ${uncoveredComps.map(id => COMPS[id]?.name).join(', ')} — oude gecachete wedstrijden blijven staan maar worden niet ververst.`);
  }

  // Globale "vandaag"-scrape: ALLE wedstrijden wereldwijd, los van de vaste
  // competitielijst hierboven. Alleen van vandaag (zie scrapeGlobalMatches).
  // Skip wedstrijden die al via een van de bovenstaande specifieke scrapers
  // binnen zijn gekomen (zelfde teams + datum), zodat er geen dubbele kaarten
  // ontstaan.
  try {
    const globalMatches = await scrapeGlobalMatches();
    for (const key of [...byId.keys()]) {
      const m = byId.get(key);
      if (m.source === 'betexplorer_global') byId.delete(key);
    }
    const snapshot = [...byId.entries()];
    let addedGlobal = 0, skippedDup = 0;
    for (const scraped of globalMatches) {
      const nH = normTeam(scraped.h), nA = normTeam(scraped.a);
      const dup = snapshot.some(([, m]) => m.date === scraped.date && normTeam(m.h) === nH && normTeam(m.a) === nA);
      if (dup) { skippedDup++; continue; }
      byId.set(scraped.apiId, scraped);
      addedGlobal++;
    }
    log.push(`Wereldwijd (betexplorer-homepage, alleen vandaag): ${globalMatches.length} wedstrijden gevonden, ${addedGlobal} toegevoegd, ${skippedDup} al aanwezig via specifieke scraper`);
  } catch (e) {
    log.push(`Globale scrape FAIL: ${e.message.slice(0, 150)}`);
  }

  const all = [...byId.values()];
  await kvPut(env, 'matches_all', { matches: all, updatedAt: now.toISOString() });
  const form = computeForm(all);
  await kvPut(env, 'standings_all', { standings: form, updatedAt: now.toISOString() });
  log.push(`vorm berekend voor ${form.length} teams (alleen op basis van wedstrijden met bekende uitslag)`);

  const globalMeta = { lastRun: now.toISOString(), totalMatches: all.length };
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
    if (url.pathname === '/standings') return json(await kvGet(env, 'standings_all', { standings: [] }));

    // Odds voor alle momenteel gescrapete wedstrijden (odds1x2.com), in
    // dezelfde vorm als de oude the-odds-api-gebaseerde /odds-route
    // ({matches: {key: {h,a,sport,odds:{'1X2':{h,d,a,bm}}}}}) zodat de
    // frontend (ODDS_API_DATA/getOddsApiMatch) ongewijzigd kan blijven.
    if (url.pathname === '/odds') {
      const d = await kvGet(env, 'matches_all', { matches: [] });
      const scrapedMatches = (d.matches || []).filter(m => m.source === 'odds1x2');
      const result = {};
      for (const m of scrapedMatches) {
        try {
          const odds = await getOddsForMatch(env, m.compId, m.h, m.a);
          if (!odds || odds.error) continue;
          result[`${m.h}_${m.a}`] = {
            h: m.h, a: m.a, sport: m.compName,
            odds: { '1X2': { h: odds.home?.best, d: odds.draw?.best, a: odds.away?.best, bm: 'odds1x2.com' } },
          };
        } catch { /* deze wedstrijd overslaan */ }
      }
      return json({ matches: result, fetchedAt: new Date().toISOString() });
    }
    if (url.pathname === '/player-stats') {
      const wk = await kvGet(env, 'player_stats', {});
      return json(wk);
    }

    // Kansmodel + odds1x2-odds + Workers AI (env.AI) leesbare analyse.
    // Vervangt de oude /ai-bet die de betaalde Anthropic-API gebruikte.
    if (url.pathname === '/ai-analyse') {
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

      const prompt = `Je bent een nuchtere voetbalanalist. Wedstrijd: ${match.h} vs ${match.a} (${match.compName || ''}, ${match.date} ${match.time}).
Modelkansen (Poisson, op basis van eigen vormberekening uit gespeelde wedstrijden): thuis ${(model.pHome * 100).toFixed(1)}%, gelijk ${(model.pDraw * 100).toFixed(1)}%, uit ${(model.pAway * 100).toFixed(1)}%.
${odds && !odds.error ? `Bookmaker-odds (beste gevonden prijs): thuis ${odds.home?.best}, gelijk ${odds.draw?.best}, uit ${odds.away?.best}.` : 'Geen bookmaker-odds beschikbaar voor deze wedstrijd.'}
Geef in maximaal 4 zinnen Nederlandstalige analyse: is er een value bet (modelkans duidelijk hoger dan wat de odds impliceren)? Wees kritisch en nuchter — het model is simpel (Poisson op vorm) en geen garantie.`;

      try {
        const aiResult = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [{ role: 'user', content: prompt }],
        });
        return json({
          match: { apiId: match.apiId, h: match.h, a: match.a, date: match.date, time: match.time, compName: match.compName },
          model: { pHome: model.pHome, pDraw: model.pDraw, pAway: model.pAway },
          odds,
          analysis: aiResult.response || aiResult,
        });
      } catch (e) {
        return json({ error: `Workers AI fout: ${e.message}` }, 500);
      }
    }

    // Vrije-vorm prompt-endpoint voor de frontend (AI-bet-tips-kaarten in
    // index.html). Gebruikt Workers AI (env.AI) i.p.v. de vroegere,
    // betaalde Anthropic-API — response-vorm blijft compatibel
    // ({content:[{text}]}) zodat de bestaande frontend-code ongewijzigd werkt.
    if (url.pathname === '/ai-bet') {
      if (req.method === 'GET') return json({ ok: true, backend: 'Cloudflare Workers AI' });
      try {
        const body = await req.json();
        const aiResult = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [{ role: 'user', content: body.prompt }],
        });
        return json({ content: [{ text: aiResult.response || '' }] });
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
        const res = await fetch(target, { headers: { 'User-Agent': SCRAPE_UA } });
        const text = await res.text();
        return json({ status: res.status, length: text.length, snippet: text.slice(offset, offset + len) });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (url.pathname === '/debug') {
      const meta = await kvGet(env, 'meta_global', {});
      const d = await kvGet(env, 'matches_all', { matches: [] });
      const s = await kvGet(env, 'standings_all', { standings: [] });
      return json({ meta, totalMatches: (d.matches || []).length, totalTeamsMetVorm: (s.standings || []).length });
    }

    // Clublogo's: gratis, geen API-key nodig via TheSportsDB's publieke
    // test-endpoint (key "3"). We cachen de gevonden badge-URL permanent per
    // team in KV, zodat we TheSportsDB niet steeds opnieuw hoeven te vragen.
    // Geeft een 302-redirect naar de echte afbeelding terug zodat de
    // frontend 'm gewoon als <img src="/crest?team=..."> kan gebruiken.
    if (url.pathname === '/crest') {
      const team = url.searchParams.get('team') || '';
      if (!team) return new Response('', { status: 400 });
      const cacheKey = `crest_${normTeam(team)}`;
      let cached = await kvGet(env, cacheKey, null);
      // Alleen een GEVONDEN badge is permanent geldig om te cachen. Een
      // eerdere mislukte/niet-gevonden lookup slaan we NIET op — anders
      // blijft die voor altijd "vastzitten" en wordt de zoekopdracht nooit
      // opnieuw geprobeerd (bug: eerdere versie cachete ook {badge:null}).
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

    return json({ error: 'not found', routes: ['/matches', '/comps', '/odds', '/standings', '/player-stats', '/ai-analyse', '/ai-bet', '/value-bet', '/check-pin', '/visitors', '/refresh', '/crest', '/debug'] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env, {}));
  },
};
