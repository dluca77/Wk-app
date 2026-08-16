import { chromium } from 'playwright';

const LEAGUES = ['EPL', 'La_liga', 'Bundesliga', 'Serie_A', 'Ligue_1', 'RFPL'];
const SEASON = '2025';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const teams = new Map(); // slug -> league

  for (const league of LEAGUES) {
    await page.goto(`https://understat.com/league/${league}/${SEASON}`, { waitUntil: 'networkidle', timeout: 30000 });
    const hrefs = await page.locator('a').evaluateAll(els => els.map(el => el.getAttribute('href')));
    for (const href of hrefs) {
      const m = href && href.match(/^team\/([^/]+)\/\d+$/);
      if (m) teams.set(m[1], league);
    }
  }
  console.error(`totaal teams gevonden: ${teams.size}`);

  const players = [];
  for (const [slug, league] of teams) {
    try {
      await page.goto(`https://understat.com/team/${slug}/${SEASON}`, { waitUntil: 'networkidle', timeout: 30000 });
      const rows = await page.locator('table').nth(1).locator('tbody tr').evaluateAll(trs =>
        trs.map(tr => {
          const cells = [...tr.querySelectorAll('td')];
          const link = tr.querySelector('a[href*="player/"]');
          const id = link ? link.getAttribute('href').match(/player\/(\d+)/)?.[1] : null;
          const text = i => cells[i]?.textContent.trim() ?? '';
          const num = i => parseFloat(text(i).replace(/[^\d.-]/g, '')) || 0;
          return {
            id,
            name: text(1),
            pos: text(2),
            apps: num(3),
            min: num(4),
            g: num(5),
            a: num(6),
            sh90: num(7),
            kp90: num(8),
            xg: num(9),
            xa: num(10),
            xg90: num(11),
            xa90: num(12),
          };
        }).filter(p => p.id)
      );
      const team = slug.replace(/_/g, ' ');
      for (const p of rows) players.push({ ...p, team, league, season: SEASON });
      console.error(`${team}: ${rows.length} spelers`);
    } catch (e) {
      console.error(`${slug}: fout - ${e.message}`);
    }
  }

  await browser.close();
  console.log(JSON.stringify({ players, updatedAt: new Date().toISOString() }));
}

main();
