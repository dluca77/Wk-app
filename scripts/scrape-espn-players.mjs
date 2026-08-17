// ESPN's onofficiële "core" API (sports.core.api.espn.com) blijkt — anders dan
// site.api.espn.com, die Akamai/403 geeft vanaf GitHub Actions-IP's — gewoon
// bereikbaar en niet rate-limited (getest: 20 verzoeken op rij, geen 429).
// Geen xG, maar wel goals/assists/schoten/kaarten/minuten. Dekt zowel de
// competities die Understat niet heeft (Eredivisie, UEFA-toernooien) als een
// aanvulling op de 5 die Understat wel dekt (aparte espn_-id's, dus geen
// conflict — /players in de Worker combineert beide bronnen).
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
};
// SEASON is instelbaar via env var — de dagelijkse cron gebruikt het huidige
// seizoen (live bijgewerkt), een losse eenmalige backfill-run (zie
// scrape-espn-players-backfill.yml) gebruikt vorig seizoen als vaste
// momentopname (aparte KV-key in de Worker, wordt niet overschreven).
const SEASON = process.env.SEASON || '2026';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

// Simpele concurrency-pool zodat we niet honderden requests instant afvuren
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

async function main() {
  const players = [];

  for (const [slug, leagueName] of Object.entries(LEAGUES)) {
    const teamsList = await getJson(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${slug}/seasons/${SEASON}/teams?lang=en&region=us&limit=50`);
    const teamRefs = (teamsList?.items || []).map(i => i.$ref);
    console.error(`${leagueName}: ${teamRefs.length} teams gevonden`);

    for (const teamRef of teamRefs) {
      const team = await getJson(teamRef);
      if (!team) continue;
      const teamName = team.displayName || team.name || '?';
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
        if (apps === 0 && min === 0) return null; // nog niet gespeeld dit seizoen
        const per90 = min > 0 ? min / 90 : 0;
        return {
          id: `espn_${SEASON}_${ath.id}`,
          name: ath.displayName || ath.fullName || '?',
          pos: ath.position?.abbreviation || '',
          apps, min, g, a,
          sh90: per90 ? +(shots / per90).toFixed(2) : 0,
          kp90: 0, // ESPN heeft geen "key passes" veld zoals Understat
          xg: 0, xa: 0, xg90: 0, xa90: 0, // geen xG-data bij ESPN
          sot90: per90 ? +(sot / per90).toFixed(2) : 0,
          team: teamName, league: leagueName, season: SEASON,
        };
      });
      for (const p of teamPlayers) if (p) players.push(p);
      console.error(`  ${teamName}: ${teamPlayers.filter(Boolean).length} spelers`);
    }
  }

  console.log(JSON.stringify({ players, updatedAt: new Date().toISOString() }));
}

main();
