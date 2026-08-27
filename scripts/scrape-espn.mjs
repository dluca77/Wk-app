// Eén databron voor alles: ESPN's onofficiële "core" API
// (sports.core.api.espn.com). Anders dan site.api.espn.com (die Akamai/403
// geeft vanaf cloud-IP's, getest vanuit deze GitHub Actions-omgeving) is
// deze core-API gewoon bereikbaar zonder blokkade en zonder API-key.
//
// Twee fases, om Livescore-achtige breedte te krijgen zonder de looptijd te
// laten ontploffen:
// 1. DISCOVERY — alle ~218 voetbalcompetities die ESPN kent (opgehaald via
//    de /leagues-masterlijst) krijgen één goedkope events-aanvraag om te
//    zien of ze wedstrijden hebben in het datumvenster. De meeste landen/
//    bekers hebben op een willekeurige dag niks — die vallen meteen af.
// 2. DETAIL — voor elke competitie die wél iets heeft, worden de echte
//    wedstrijden (teams/tijd/uitslag) opgehaald. Spelersstats (schoten/
//    schoten-op-doel, dus team→spelers→season-stats, veel duurder) worden
//    alleen gedaan voor de PRIORITY_LEAGUES-lijst hieronder — anders zou één
//    scrape-run met 100+ actieve competities veel te lang duren. Wedstrijden
//    uit niet-prioritaire competities worden dus wel getoond, alleen zonder
//    speler-schotenvoorspelling.
const PRIORITY_LEAGUES = new Set([
  'ned.1', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf',
  'uefa.champions_qual', 'uefa.europa_qual', 'uefa.europa.conf_qual',
  'eng.1', 'esp.1', 'ger.1', 'ita.1', 'fra.1',
  'eng.2', 'ned.2', 'por.1', 'bel.1', 'tur.1', 'sco.1',
  'usa.1', 'mex.1', 'bra.1', 'ksa.1', 'eng.league_cup', 'eng.fa',
]);

const SEASON = process.env.SEASON || '2026';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BASE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

// Competitienieuws: ESPN's "site.api" (i.t.t. de core-API hierboven, NIET
// geblokkeerd voor dit specifieke /news-pad — apart getest vanuit deze
// GitHub Actions-omgeving, in tegenstelling tot bv. /scoreboard). Alleen
// voor PRIORITY_LEAGUES gescraped, want dit voegt geen waarde toe voor
// obscure competities en houdt de looptijd bewaakt. Wordt in de Worker
// gebruikt als extra AI-context (transfers, blessures, schorsingen e.d.),
// niet los als gestructureerde data — het is vrije-tekst nieuws.
async function fetchNews(slug, leagueName) {
  try {
    // Let op: GEEN browser-UA meesturen hier (anders dan getJson() voor de
    // core-API) — site.api.espn.com blokkeert deze /news-route juist mét een
    // browser-achtige User-Agent (403), maar staat 'm toe met de standaard-
    // UA van fetch()/curl. Contra-intuïtief, maar bevestigd getest.
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/news`);
    if (!res.ok) return [];
    const data = await res.json();
    const articles = data?.articles || [];
    return articles.slice(0, 8).map(a => ({
      compName: leagueName,
      headline: a.headline || '',
      description: a.description || '',
      published: a.published || '',
    })).filter(a => a.headline);
  } catch {
    return [];
  }
}

async function pool(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function statVal(stats, name) {
  const s = stats.find(s => s.name === name);
  return s ? s.value : 0;
}

// ESPN geeft wedstrijddatums in UTC — de app moet Nederlandse (lokale)
// tijd tonen, dus hier omrekenen incl. zomer-/wintertijd (DST).
const nlFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function toNlDateTime(isoUtc) {
  const parts = nlFmt.formatToParts(new Date(isoUtc));
  const get = t => parts.find(p => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// Datumvenster: 10 dagen terug (voor vorm/season-stats) t/m 10 dagen vooruit
// (aankomende wedstrijden). ESPN's core API accepteert een dash-range.
function dateRange() {
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 10);
  const to = new Date(now); to.setDate(to.getDate() + 10);
  return `${fmt(from)}-${fmt(to)}`;
}

// ---------- Fase 1: discovery — welke competities hebben wedstrijden? ----------
async function discoverActiveLeagues() {
  const list = await getJson(`${BASE}?lang=en&region=us&limit=500`);
  const slugs = (list?.items || [])
    .map(it => it.$ref?.match(/\/leagues\/([^?]+)/)?.[1])
    .filter(Boolean);
  console.error(`discovery: ${slugs.length} competities bekend bij ESPN`);

  const range = dateRange();
  const checked = await pool(slugs, 16, async (slug) => {
    const d = await getJson(`${BASE}/${slug}/events?lang=en&region=us&dates=${range}&limit=1`);
    return { slug, count: d?.count || 0 };
  });
  const active = checked.filter(c => c.count > 0).map(c => c.slug);
  console.error(`discovery: ${active.length} competities hebben wedstrijden in dit venster`);
  return active;
}

async function fetchLeagueInfo(slug) {
  const d = await getJson(`${BASE}/${slug}?lang=en&region=us`);
  const logo = d?.logos?.find(l => l.rel?.includes('default'))?.href || d?.logos?.[0]?.href || null;
  return { name: d?.displayName || d?.name || slug, logo };
}

// ---------- Fase 2a: wedstrijden voor één competitie (goedkoop) ----------
async function scrapeMatches(slug, leagueName, leagueLogo, teamIdToName) {
  const range = dateRange();
  const eventsList = await getJson(`${BASE}/${slug}/events?lang=en&region=us&dates=${range}&limit=100`);
  const eventRefs = (eventsList?.items || []).map(i => i.$ref);
  const matches = (await pool(eventRefs, 8, async (ref) => {
    const ev = await getJson(ref);
    if (!ev) return null;
    const comp = ev.competitions?.[0];
    if (!comp) return null;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    const homeId = home?.team?.$ref?.match(/teams\/(\d+)/)?.[1];
    const awayId = away?.team?.$ref?.match(/teams\/(\d+)/)?.[1];
    let h = teamIdToName?.get(homeId);
    let a = teamIdToName?.get(awayId);
    // Niet-prioritaire competities hebben geen vooraf opgehaalde teamlijst
    // (te duur om voor 100+ competities te doen) — dan de teamnaam per
    // wedstrijd direct van de team-ref zelf lezen.
    if (!h && home?.team?.$ref) h = (await getJson(home.team.$ref))?.displayName;
    if (!a && away?.team?.$ref) a = (await getJson(away.team.$ref))?.displayName;
    if (!h || !a) return null;

    const status = await getJson(comp.status?.$ref);
    const state = status?.type?.state; // 'pre' | 'in' | 'post'
    const finished = state === 'post';
    const live = state === 'in';

    let result = null;
    if (finished || live) {
      const [hs, as] = await Promise.all([
        getJson(home?.score?.$ref),
        getJson(away?.score?.$ref),
      ]);
      if (hs && as) result = `${Math.round(hs.value)}-${Math.round(as.value)}`;
    }

    const { date, time } = toNlDateTime(ev.date);
    return {
      apiId: `espn_${ev.id}`,
      compId: slug,
      compName: leagueName,
      compLogo: leagueLogo,
      h, a,
      date, time,
      status: finished ? 'played' : live ? 'live' : 'fixture',
      live, finished, result,
      venue: comp.venue?.fullName || '',
    };
  })).filter(Boolean);
  return matches;
}

// ---------- Fase 2b: spelers (season-totalen) — alleen prioriteitscompetities ----------
async function scrapePlayers(leagueName, teams) {
  const players = [];
  for (const team of teams) {
    const athletesRef = team.athletes?.$ref;
    if (!athletesRef) continue;
    const athletesList = await getJson(`${athletesRef}&limit=60`);
    const athleteRefs = (athletesList?.items || []).map(i => i.$ref);
    const teamPlayers = await pool(athleteRefs, 6, async (athRef) => {
      const ath = await getJson(athRef);
      if (!ath) return null;
      const statsRef = ath.statistics?.$ref;
      if (!statsRef) return null;
      const statsData = await getJson(statsRef);
      const cats = statsData?.splits?.categories || [];
      const gen = cats.find(c => c.name === 'general')?.stats || [];
      const off = cats.find(c => c.name === 'offensive')?.stats || [];
      const def = cats.find(c => c.name === 'defensive')?.stats || [];
      const apps = statVal(gen, 'appearances');
      const min = statVal(gen, 'minutes');
      const g = statVal(off, 'totalGoals');
      const a = statVal(off, 'goalAssists');
      const shots = statVal(off, 'totalShots');
      const sot = statVal(off, 'shotsOnTarget');
      const yellow = statVal(gen, 'yellowCards');
      const red = statVal(gen, 'redCards');
      const fouls = statVal(gen, 'foulsCommitted');
      const corners = statVal(gen, 'wonCorners');
      const tackles = statVal(def, 'totalTackles');
      if (apps === 0 && min === 0) return null;
      // Gemiddelde per gespeelde wedstrijd (niet per-90-minuten-extrapolatie
      // — die blies het cijfer enorm op bij korte invalbeurten, bv. iemand
      // met 4 schoten in 28 minuten leek dan "12,86 schoten per 90 min").
      return {
        playerId: `espn_${SEASON}_${ath.id}`,
        name: ath.displayName || ath.fullName || '?',
        pos: ath.position?.abbreviation || '',
        apps, mins: min, goals: g, assists: a,
        shots: shots, sot: sot,
        shotsAvg: apps ? +(shots / apps).toFixed(2) : 0,
        sotAvg: apps ? +(sot / apps).toFixed(2) : 0,
        yellowCards: yellow, redCards: red, fouls, corners, tackles,
        team: team.displayName || team.name, compName: leagueName,
      };
    });
    for (const p of teamPlayers) if (p) players.push(p);
  }
  return players;
}

// ---------- Fase 2c: officiële stand (punten/GD/positie) — alleen prioriteitscompetities ----------
async function scrapeStandings(slug, leagueName, teamIdToName) {
  if (!teamIdToName) return [];
  let entries = null;
  try {
    const d = await getJson(`${BASE}/${slug}/seasons/${SEASON}/types/1/groups/1/standings/0?lang=en&region=us`);
    entries = d?.standings || null;
  } catch { /* val door op alternatieve route hieronder */ }
  if (!entries) {
    const list = await getJson(`${BASE}/${slug}/seasons/${SEASON}/types/1/standings?lang=en&region=us`);
    const first = list?.items?.[0]?.$ref;
    if (first) {
      const d = await getJson(first);
      entries = d?.standings || null;
    }
  }
  if (!entries) return [];

  return entries.map((e, idx) => {
    const teamId = e.team?.$ref?.match(/teams\/(\d+)/)?.[1];
    const team = teamIdToName.get(teamId);
    const overall = e.records?.find(r => r.name === 'overall')?.stats || e.stats || [];
    const val = name => overall.find(s => s.name === name)?.value ?? 0;
    return {
      team, position: idx + 1, compName: leagueName,
      played: val('gamesPlayed'), win: val('wins'), draw: val('ties'), loss: val('losses'),
      gf: val('pointsFor'), ga: val('pointsAgainst'), gd: val('pointDifferential'), pts: val('points'),
    };
  }).filter(s => s.team);
}

async function processLeague(slug, isPriority) {
  const { name: leagueName, logo: leagueLogo } = await fetchLeagueInfo(slug);
  let teamIdToName, teams;
  if (isPriority) {
    const teamsList = await getJson(`${BASE}/${slug}/seasons/${SEASON}/teams?lang=en&region=us&limit=50`);
    const teamRefs = (teamsList?.items || []).map(i => i.$ref);
    teams = (await pool(teamRefs, 8, ref => getJson(ref))).filter(Boolean);
    teamIdToName = new Map(teams.map(t => [String(t.id), t.displayName || t.name]));
  }

  const matches = await scrapeMatches(slug, leagueName, leagueLogo, teamIdToName);
  const players = isPriority && teams?.length ? await scrapePlayers(leagueName, teams) : [];
  let standings = [];
  if (isPriority) {
    try { standings = await scrapeStandings(slug, leagueName, teamIdToName); }
    catch (e) { console.error(`${leagueName} standen FOUT: ${e.message}`); }
  }
  let news = [];
  if (isPriority) {
    try { news = await fetchNews(slug, leagueName); }
    catch (e) { console.error(`${leagueName} nieuws FOUT: ${e.message}`); }
  }
  console.error(`${leagueName} (${slug}): ${matches.length} wedstrijden${isPriority ? `, ${players.length} spelers, ${standings.length} standen, ${news.length} nieuwsartikelen` : ''}`);
  return { matches, players, standings, news };
}

async function main() {
  const activeSlugs = await discoverActiveLeagues();
  // Prioriteitscompetities altijd meenemen ook al had de discovery-check
  // toevallig 0 wedstrijden in dit venster (bv. Champions League-groepsfase
  // moet nog beginnen) — zodat ze meteen weer meedoen zodra dat wél zo is.
  const allSlugs = [...new Set([...activeSlugs, ...PRIORITY_LEAGUES])];

  const results = await pool(allSlugs, 6, async (slug) => {
    try {
      return await processLeague(slug, PRIORITY_LEAGUES.has(slug));
    } catch (e) {
      console.error(`${slug} FOUT: ${e.message}`);
      return { matches: [], players: [] };
    }
  });

  const allMatches = results.flatMap(r => r.matches);
  const allPlayers = results.flatMap(r => r.players);
  const allStandings = results.flatMap(r => r.standings || []);
  const allNews = results.flatMap(r => r.news || []);
  console.error(`totaal: ${allMatches.length} wedstrijden, ${allPlayers.length} spelers, ${allStandings.length} standen, ${allNews.length} nieuwsartikelen uit ${allSlugs.length} competities`);
  process.stdout.write(JSON.stringify({ matches: allMatches, players: allPlayers, standings: allStandings, news: allNews, updatedAt: new Date().toISOString() }));
}

main();
