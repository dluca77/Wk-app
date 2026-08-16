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

// In plaats van één lange samengestelde regex (fragiel gebleken — de exacte
// afstand tussen attributen varieert blijkbaar meer dan verwacht) zoeken we
// per wedstrijd-blok (elk begint bij "data-ts=") de losse velden apart op
// binnen een ruim tekstvenster. Veel robuuster tegen kleine structuurverschillen.
function parseGlobalMatches(html) {
  const headers = [];
  const headerRe = /data-league-name="([^"]+)"[^]{0,150}?data-country-name="([^"]+)"/g;
  let hm;
  while ((hm = headerRe.exec(html))) headers.push({ idx: hm.index, league: hm[1], country: hm[2] });

  const matches = [];
  const marker = 'data-ts="';
  let searchFrom = 0;
  while (true) {
    const start = html.indexOf(marker, searchFrom);
    if (start === -1) break;
    searchFrom = start + marker.length;
    const chunk = html.slice(start, start + 3000);

    const dtM = chunk.match(/data-dt="(\d+),(\d+),(\d+),(\d+),(\d+)"/);
    const hrefM = chunk.match(/href="(\/football\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/[a-zA-Z0-9]+\/)"/);
    const homeM = chunk.match(/participantHome[^>]*>\s*<p[^>]*>([^<]+)<\/p>/);
    const awayM = chunk.match(/participantAway[^>]*>[^]*?<p[^>]*>([^<]+)<\/p>/);
    if (!dtM || !hrefM || !homeM || !awayM) continue;

    const statusM = chunk.match(/data-live-cell="time">\s*([^<]*?)\s*</);
    // Uitslag: data-live-cell="score"> ... <div class="table-main__finishedResults">2</div> ... :</div> ... 1</div>
    const scoreM = chunk.match(/data-live-cell="score">[^]*?table-main__finishedResults">(\d+)<\/div>[^]*?table-main__finishedResults">:<\/div>[^]*?table-main__finishedResults">(\d+)<\/div>/);
    const idx = start;
    let hdr = null;
    for (const h of headers) { if (h.idx <= idx) hdr = h; else break; }
    const [, dd, mo, yy, hh, mi] = dtM;
    const date = `${yy}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const time = `${hh.padStart(2, '0')}:${mi.padStart(2, '0')}`;
    const statusTrim = (statusM?.[1] || '').trim();
    const finished = /^FIN/i.test(statusTrim);
    const live = !finished && statusTrim !== '' && !/^\d{1,2}:\d{2}$/.test(statusTrim);
    const result = scoreM ? `${scoreM[1]}-${scoreM[2]}` : null;
    matches.push({
      apiId: `betexplorer_global_${hrefM[1]}`,
      compId: hdr ? `be_${hdr.country}_${hdr.league}` : 'be_onbekend',
      compName: hdr ? hdr.league : 'Onbekend',
      compFlag: hdr ? countryFlag(hdr.country) : '🌍',
      h: homeM[1].trim(), a: awayM[1].trim(),
      date, time, result, live, finished,
      venue: '', round: '', source: 'betexplorer_global',
    });
  }
  return matches.filter(m => m.h && m.a);
}

const html = readFileSync(process.argv[2] || 'home.html', 'utf-8');
const matches = parseGlobalMatches(html);
process.stdout.write(JSON.stringify({ matches }));
