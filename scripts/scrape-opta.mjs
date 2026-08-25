// Scrapet de publieke "Betting Showcase" backend van Stats Perform
// (optaplayerstats.statsperform.com) — een widget bedoeld om naast een
// bookmaker-odds-widget te embedden. De backend-API zelf vereist geen
// API-key en levert écht Opta-datakwaliteit: xG, schoten (binnen/buiten
// het strafschopgebied), per speler per wedstrijd.
//
// Twee endpoints:
// - /api/en_GB/soccer/livescores?offset=-120  → alle wedstrijden in het
//   huidige "venster" (vandaag + morgen, ± 9 competities — curated voor de
//   widget, geen volledige wereldwijde dekking).
// - /api/en_GB/soccer/playerprops/match/{id}  → per-speler matchstats
//   (alleen beschikbaar zodra de wedstrijd bezig is/afgelopen is).
//
// Draait in GitHub Actions, niet in de Cloudflare Worker — nooit getest of
// Cloudflare-IP's hier geblokkeerd worden (zoals bij betexplorer.com), dus
// voor de zekerheid dezelfde ingest-aanpak als de vorige databronnen.
const SOURCE = 'https://optaplayerstats.statsperform.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

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

async function main() {
  const live = await getJson(`${SOURCE}/api/en_GB/soccer/livescores?offset=-120`);
  const rawMatches = live?.matches || [];

  const matches = rawMatches.map(m => ({
    apiId: `opta_${m.id}`,
    optaId: m.id,
    compId: m.comp?.id,
    compName: m.comp?.name,
    country: m.comp?.country?.fullName || m.comp?.country?.name || '',
    h: m.home?.name,
    a: m.away?.name,
    date: new Date(m.date * 1000).toISOString().slice(0, 10),
    time: new Date(m.date * 1000).toISOString().slice(11, 16),
    status: m.status, // 'fixture' | 'live' | 'played'
    live: m.status === 'live',
    finished: m.status === 'played',
    result: m.score?.ft ? `${m.score.ft.home}-${m.score.ft.away}` : (m.score?.total ? `${m.score.total.home}-${m.score.total.away}` : null),
    events: m.events || [],
  }));

  // Playerprops (per-speler matchstats: schoten, xG) alleen ophalen voor
  // wedstrijden die al gespeeld zijn/bezig zijn — bij 'fixture' bestaat er
  // simpelweg nog geen data (nog niet gespeeld).
  const needProps = matches.filter(m => m.status === 'played' || m.status === 'live');
  console.error(`${matches.length} wedstrijden gevonden, ${needProps.length} met spelerdata op te halen`);

  const propsResults = await pool(needProps, 6, async (m) => {
    const data = await getJson(`${SOURCE}/api/en_GB/soccer/playerprops/match/${m.optaId}`);
    return { optaId: m.optaId, data };
  });
  const propsByMatch = new Map(propsResults.filter(r => r.data).map(r => [r.optaId, r.data]));

  // Platte lijst van speler-matchstats (voor season-aggregatie in de Worker,
  // die dit over meerdere runs heen opstapelt net zoals computeForm() dat nu
  // al doet voor team-vorm).
  const playerMatchStats = [];
  for (const m of needProps) {
    const props = propsByMatch.get(m.optaId);
    const lineUp = props?.liveData?.lineUp || [];
    for (const team of lineUp) {
      for (const p of team.players || []) {
        const s = p.stats || {};
        const shots = (s.attemptsIbox || 0) + (s.attemptsObox || 0) + (s.attHdTotal || 0);
        playerMatchStats.push({
          matchApiId: m.apiId,
          date: m.date,
          playerId: p.playerId,
          name: p.matchName || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
          pos: p.position,
          team: team.name,
          teamId: team.contestantId,
          compName: m.compName,
          minsPlayed: s.minsPlayed || 0,
          shots,
          xg: s.expectedGoals || 0,
          goals: (s.attOboxGoal || 0) + (s.attRfGoal || 0) + (s.attLfGoal || 0) + (s.attHdGoal || 0) + (s.attPenGoal || 0) + (s.attFreekickGoal || 0),
        });
      }
    }
  }

  process.stdout.write(JSON.stringify({ matches, playerMatchStats, updatedAt: new Date().toISOString() }));
}

main();
