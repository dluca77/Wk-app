// Parseert de betexplorer.com-homepage naar een lijst wedstrijden van
// vandaag, wereldwijd. Draait in GitHub Actions (niet in de Cloudflare
// Worker, want die krijgt vanaf Cloudflare's eigen IP-adressen een lege
// versie van deze pagina terug — zie worker/index.js voor de toelichting).
// Zelfde parse-logica als parseGlobalMatches() in worker/index.js.
import { readFileSync } from 'fs';

const COUNTRY_FLAGS = {
  'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'Wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿', 'Spain': '🇪🇸', 'Germany': '🇩🇪', 'Italy': '🇮🇹', 'France': '🇫🇷',
  'Netherlands': '🇳🇱', 'Portugal': '🇵🇹', 'Belgium': '🇧🇪', 'Turkey': '🇹🇷', 'Greece': '🇬🇷', 'Austria': '🇦🇹',
  'Switzerland': '🇨🇭', 'Poland': '🇵🇱', 'Ukraine': '🇺🇦', 'Russia': '🇷🇺', 'Denmark': '🇩🇰', 'Sweden': '🇸🇪',
  'Norway': '🇳🇴', 'Finland': '🇫🇮', 'Croatia': '🇭🇷', 'Serbia': '🇷🇸', 'Romania': '🇷🇴', 'Czech Republic': '🇨🇿',
  'Hungary': '🇭🇺', 'Bulgaria': '🇧🇬', 'Slovakia': '🇸🇰', 'Slovenia': '🇸🇮', 'Ireland': '🇮🇪', 'Israel': '🇮🇱',
  'USA': '🇺🇸', 'Mexico': '🇲🇽', 'Brazil': '🇧🇷', 'Argentina': '🇦🇷', 'Chile': '🇨🇱', 'Colombia': '🇨🇴', 'Uruguay': '🇺🇾',
  'Peru': '🇵🇪', 'Ecuador': '🇪🇨', 'Paraguay': '🇵🇾', 'Bolivia': '🇧🇴', 'Venezuela': '🇻🇪', 'Japan': '🇯🇵',
  'South Korea': '🇰🇷', 'China': '🇨🇳', 'Australia': '🇦🇺', 'Saudi Arabia': '🇸🇦', 'Qatar': '🇶🇦', 'Morocco': '🇲🇦',
  'Egypt': '🇪🇬', 'South Africa': '🇿🇦', 'Nigeria': '🇳🇬', 'Canada': '🇨🇦', 'Iceland': '🇮🇸',
};
function countryFlag(country) { return COUNTRY_FLAGS[country] || '🌍'; }

function parseGlobalMatches(html) {
  const headers = [];
  const headerRe = /data-league-name="([^"]+)"[^]{0,150}?data-country-name="([^"]+)"/g;
  let hm;
  while ((hm = headerRe.exec(html))) headers.push({ idx: hm.index, league: hm[1], country: hm[2] });

  const matches = [];
  const matchRe = /data-ts="(\d+)"[^]{0,250}?data-dt="(\d+),(\d+),(\d+),(\d+),(\d+)"[^]{0,400}?data-live-cell="time">\s*([^<]*?)\s*<[^]{0,600}?href="(\/football\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/[a-zA-Z0-9]+\/)"[^]{0,600}?participantHome[^>]*>\s*<p[^>]*>([^<]+)<\/p>[^]{0,300}?participantAway[^>]*>[^]{0,250}?<p[^>]*>([^<]+)<\/p>/g;
  let mm;
  while ((mm = matchRe.exec(html))) {
    const idx = mm.index;
    let hdr = null;
    for (const h of headers) { if (h.idx <= idx) hdr = h; else break; }
    const [, , dd, mo, yy, hh, mi, status, href, home, away] = mm;
    const date = `${yy}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const time = `${hh.padStart(2, '0')}:${mi.padStart(2, '0')}`;
    const statusTrim = (status || '').trim();
    const finished = /^FIN/i.test(statusTrim);
    const live = !finished && statusTrim !== '' && !/^\d{1,2}:\d{2}$/.test(statusTrim);
    matches.push({
      apiId: `betexplorer_global_${href}`,
      compId: hdr ? `be_${hdr.country}_${hdr.league}` : 'be_onbekend',
      compName: hdr ? hdr.league : 'Onbekend',
      compFlag: hdr ? countryFlag(hdr.country) : '🌍',
      h: (home || '').trim(), a: (away || '').trim(),
      date, time, result: null, live, finished,
      venue: '', round: '', source: 'betexplorer_global',
    });
  }
  return matches.filter(m => m.h && m.a);
}

const html = readFileSync(process.argv[2] || 'home.html', 'utf-8');
const matches = parseGlobalMatches(html);
process.stdout.write(JSON.stringify({ matches }));
