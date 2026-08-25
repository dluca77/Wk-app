// Eén databron voor alles: ESPN's onofficiële "core" API
// (sports.core.api.espn.com). Anders dan site.api.espn.com (die Akamai/403
// geeft vanaf cloud-IP's, getest vanuit deze GitHub Actions-omgeving) is
// deze core-API gewoon bereikbaar zonder blokkade en zonder API-key.
// Levert zowel wedstrijdschema's/uitslagen als per-speler matchstats
// (goals/assists/schoten/schoten-op-doel) — geen xG, maar wel alles wat
// nodig is voor winkans + speler-schotenvoorspellingen, uit één bron.
const LEAGUES = {
  'ned.1': 'Eredivisie',
  'uefa.champions': 'Champions League',
  'uefa.europa': 'Europa League',
  'uefa.europa.conf': 'Conference League',
  'eng.1': 'Premier League',
  'esp.1': 'La Liga',
  'ger.1': 'Bundesliga',
  'ita.1': 'Serie A',
  'fra.1': 'Ligue 1',
  // Bredere dekking zodat er op meer dagen daadwerkelijk iets te zien is
  // (net als op Livescore) — niet alleen de "grote 5" + Europese bekers.
  'eng.2': 'Championship',
  'ned.2': 'Eerste Divisie',
  'por.1': 'Primeira Liga',
  'bel.1': 'Pro League',
  'tur.1': 'Süper Lig',
  'sco.1': 'Scottish Premiership',
  'usa.1': 'MLS',
  'mex.1': 'Liga MX',
  'bra.1': 'Brasileirão',
};
const SEASON = process.env.SEASON || '2026';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BASE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
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

// Datumvenster: 10 dagen terug (voor vorm/season-stats) t/m 10 dagen vooruit
// (aankomende wedstrijden). ESPN's core API accepteert een dash-range.
function dateRange() {
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 10);
  const to = new Date(now); to.setDate(to.getDate() + 10);
  return `${fmt(from)}-${fmt(to)}`;
}

async function scrapeLeague(slug, leagueName) {
  const teamsList = await getJson(`${BASE}/${slug}/seasons/${SEASON}/teams?lang=en&region=us&limit=50`);
  const teamRefs = (teamsList?.items || []).map(i => i.$ref);
  const teamIdToName = new Map();
  const teams = [];
  for (const ref of teamRefs) {
    const t = await getJson(ref);
    if (!t) continue;
    teamIdToName.set(String(t.id), t.displayName || t.name);
    teams.push(t);
  }
  console.error(`${leagueName}: ${teams.length} teams`);

  // ---------- Wedstrijden ----------
  const eventsList = await getJson(`${BASE}/${slug}/events?lang=en&region=us&dates=${dateRange()}&limit=100`);
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
    const h = teamIdToName.get(homeId) || '';
    const a = teamIdToName.get(awayId) || '';
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

    const d = new Date(ev.date);
    return {
      apiId: `espn_${ev.id}`,
      compId: slug,
      compName: leagueName,
      h, a,
      date: d.toISOString().slice(0, 10),
      time: d.toISOString().slice(11, 16),
      status: finished ? 'played' : live ? 'live' : 'fixture',
      live, finished, result,
      venue: comp.venue?.fullName || '',
    };
  })).filter(Boolean);
  console.error(`${leagueName}: ${matches.length} wedstrijden`);

  // ---------- Spelers (season-totalen, huidig seizoen) ----------
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
      const apps = statVal(gen, 'appearances');
      const min = statVal(gen, 'minutes');
      const g = statVal(off, 'totalGoals');
      const a = statVal(off, 'goalAssists');
      const shots = statVal(off, 'totalShots');
      const sot = statVal(off, 'shotsOnTarget');
      if (apps === 0 && min === 0) return null;
      const per90 = min > 0 ? min / 90 : 0;
      return {
        playerId: `espn_${SEASON}_${ath.id}`,
        name: ath.displayName || ath.fullName || '?',
        pos: ath.position?.abbreviation || '',
        apps, mins: min, goals: g, assists: a,
        shots90: per90 ? +(shots / per90).toFixed(2) : 0,
        sot90: per90 ? +(sot / per90).toFixed(2) : 0,
        team: team.displayName || team.name, compName: leagueName,
      };
    });
    for (const p of teamPlayers) if (p) players.push(p);
  }
  console.error(`${leagueName}: ${players.length} spelers`);

  return { matches, players };
}

async function main() {
  // Competities parallel verwerken (i.p.v. één voor één) — bij 18 competities
  // scheelt dat een veelvoud aan wall-clock tijd. Concurrency-limiet van 4
  // om ESPN niet met te veel gelijktijdige requests te bestoken.
  const entries = Object.entries(LEAGUES);
  const results = await pool(entries, 4, async ([slug, name]) => {
    try {
      return await scrapeLeague(slug, name);
    } catch (e) {
      console.error(`${name} FOUT: ${e.message}`);
      return { matches: [], players: [] };
    }
  });

  const allMatches = results.flatMap(r => r.matches);
  const allPlayers = results.flatMap(r => r.players);
  process.stdout.write(JSON.stringify({ matches: allMatches, players: allPlayers, updatedAt: new Date().toISOString() }));
}

main();
