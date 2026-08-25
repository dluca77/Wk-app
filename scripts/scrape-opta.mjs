// Scrapet de publieke "Betting Showcase" backend van Stats Perform
// (optaplayerstats.statsperform.com) — een widget bedoeld om naast een
// bookmaker-odds-widget te embedden. Levert écht Opta-datakwaliteit: xG,
// schoten (binnen/buiten het strafschopgebied), per speler per wedstrijd.
//
// De backend staat achter Akamai-botdetectie: een kale curl/fetch vanaf een
// datacenter-IP (getest vanuit GitHub Actions én Cloudflare Workers) krijgt
// altijd HTTP 403 "Access Denied", ongeacht User-Agent. Alleen verzoeken die
// écht uit een browserproces komen (juiste TLS/HTTP2-fingerprint) komen
// erdoor — vandaar Playwright + headless Chromium hier, net als de vorige
// Understat-spelersscraper deed voor hetzelfde soort blokkade.
//
// Twee endpoints:
// - /api/en_GB/soccer/livescores?offset=-120  → alle wedstrijden in het
//   huidige "venster" (vandaag + morgen, ± 9 competities — curated voor de
//   widget, geen volledige wereldwijde dekking).
// - /api/en_GB/soccer/playerprops/match/{id}  → per-speler matchstats
//   (alleen beschikbaar zodra de wedstrijd bezig is/afgelopen is).
import { chromium } from 'playwright';

const SOURCE = 'https://optaplayerstats.statsperform.com';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Eerst de gewone pagina bezoeken zodat de sessie/cookies die Akamai
  // verwacht al bestaan voordat we de API zelf aanroepen.
  await page.goto(`${SOURCE}/en_GB/soccer`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const live = await page.evaluate(async () => {
    const res = await fetch('/api/en_GB/soccer/livescores?offset=-120');
    if (!res.ok) return null;
    return res.json();
  });
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

  const propsByMatch = new Map();
  for (const m of needProps) {
    const data = await page.evaluate(async (optaId) => {
      const res = await fetch(`/api/en_GB/soccer/playerprops/match/${optaId}`);
      if (!res.ok) return null;
      return res.json();
    }, m.optaId);
    if (data) propsByMatch.set(m.optaId, data);
  }

  await browser.close();

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
