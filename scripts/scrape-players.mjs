import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://understat.com/league/EPL/2025', { waitUntil: 'networkidle', timeout: 30000 });
  const html = await page.content();
  const varNames = [...html.matchAll(/var\s+(\w+)\s*=\s*JSON\.parse/g)].map(m => m[1]);
  console.error('gevonden var-namen:', JSON.stringify(varNames));
  const idx = html.indexOf('JSON.parse');
  console.error('--- context rond eerste JSON.parse ---');
  console.error(html.slice(Math.max(0, idx - 200), idx + 300));
  await browser.close();
  console.log('{}');
}

main();
