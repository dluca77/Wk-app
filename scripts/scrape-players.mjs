import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://understat.com/league/EPL/2025', { waitUntil: 'networkidle', timeout: 30000 });
  const html = await page.content();
  const names = [...html.matchAll(/(\w+)\s*=\s*JSON\.parse\(/g)].map(m => m[1]);
  console.error('alle JSON.parse var-namen:', JSON.stringify(names));
  await browser.close();
  console.log('{}');
}

main();
