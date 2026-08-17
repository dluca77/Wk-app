import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  });
  const url = 'https://fbref.com/en/comps/23/Eredivisie-Stats';
  const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  console.error('status:', res.status());
  const html = await page.content();
  console.error('html length:', html.length);
  const tableCount = await page.locator('table').count();
  console.error('table count:', tableCount);
  const title = await page.title();
  console.error('title:', title);
  // Zoek een standard stats tabel (bevat spelersnamen)
  const ids = await page.evaluate(() => [...document.querySelectorAll('table')].map(t => t.id).filter(Boolean));
  console.error('table ids:', JSON.stringify(ids));
  await browser.close();
}
main();
