import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://understat.com/league/EPL/2025', { waitUntil: 'networkidle', timeout: 30000 });
  const hrefs = await page.locator('a').evaluateAll(els => [...new Set(els.map(el => el.getAttribute('href')))]);
  console.error('alle hrefs op league-pagina:', JSON.stringify(hrefs));
  await browser.close();
  console.log('{}');
}

main();
