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

  // data-ts is een unix-timestamp in seconden (UTC, ondubbelzinnig) — daar
  // rekenen we het Nederlandse lokale tijdstip (Europe/Amsterdam, incl. DST)
  // vanuit uit, i.p.v. de dd,mm,yyyy,hh,mi uit data-dt blind over te nemen
  // (die bleek in de tijdzone van de bron te staan, niet in NL-tijd).
  const nlFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  function tsToNlDateTime(tsSeconds) {
    const parts = nlFmt.formatToParts(new Date(tsSeconds * 1000));
    const get = t => parts.find(p => p.type === t).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
  }

  const matches = [];
  const marker = 'data-ts="';
  let searchFrom = 0;
  while (true) {
    const start = html.indexOf(marker, searchFrom);
    if (start === -1) break;
    searchFrom = start + marker.length;
    const chunk = html.slice(start, start + 3000);

    const tsM = chunk.match(/data-ts="(\d+)"/);
    const hrefM = chunk.match(/href="(\/football\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/[a-zA-Z0-9]+\/)"/);
    const homeM = chunk.match(/participantHome[^>]*>\s*<p[^>]*>([^<]+)<\/p>/);
    const awayM = chunk.match(/participantAway[^>]*>[^]*?<p[^>]*>([^<]+)<\/p>/);
    if (!tsM || !hrefM || !homeM || !awayM) continue;

    const statusM = chunk.match(/data-live-cell="time">\s*([^<]*?)\s*</);
    // Uitslag: data-live-cell="score"> ... <div class="table-main__finishedResults">2</div> ... :</div> ... 1</div>
    const scoreM = chunk.match(/data-live-cell="score">[^]*?table-main__finishedResults">(\d+)<\/div>[^]*?table-main__finishedResults">:<\/div>[^]*?table-main__finishedResults">(\d+)<\/div>/);
    // 1X2-odds: drie "data-odd=" waarden op rij (thuis, gelijk, uit) in het
    // odds-blokje na de teamnamen. Niet elke wedstrijd heeft dit (bv. als er
    // nog geen bookmaker-odds bekend zijn).
    const oddsVals = [...chunk.matchAll(/data-odd="([\d.]+)"/g)].slice(0, 3).map(m => parseFloat(m[1]));
    const [oddsH, oddsD, oddsA] = oddsVals.length === 3 ? oddsVals : [null, null, null];
    const idx = start;
    let hdr = null;
    for (const h of headers) { if (h.idx <= idx) hdr = h; else break; }
    const { date, time } = tsToNlDateTime(Number(tsM[1]));
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
      oddsH, oddsD, oddsA,
      venue: '', round: '', source: 'betexplorer_global',
    });
  }
  return matches.filter(m => m.h && m.a);
}

const html = readFileSync(process.argv[2] || 'home.html', 'utf-8');
const matches = parseGlobalMatches(html);
process.stdout.write(JSON.stringify({ matches }));
