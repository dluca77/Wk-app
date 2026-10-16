import {readFile,writeFile,mkdir} from 'node:fs/promises';

export async function collectPlayerHistory(matches, players, getJson, pool){
  const supported=new Set(['eng.1','esp.1','ita.1','ger.1','fra.1','ned.1']);
  let cache={};try{cache=JSON.parse(await readFile('.cache/player-games.json','utf8'));}catch{}
  const wanted=new Set(players.filter(p=>p.apps>=3 && p.shotsAvg>=0.8).map(p=>String(p.playerId).split('_').at(-1)));
  const counts=new Map();
  const selected=matches.filter(m=>m.finished && supported.has(m.compId)).sort((a,b)=>b.date.localeCompare(a.date)).filter(m=>{
    const keys=[m.h,m.a].map(t=>`${m.compId}:${t}`);
    if(keys.every(k=>(counts.get(k)||0)>=10))return false;
    keys.forEach(k=>counts.set(k,(counts.get(k)||0)+1));return true;
  });
  const rows=(await pool(selected,4,async m=>{
    if(cache[m.apiId]?.version===2)return cache[m.apiId].rows.filter(g=>wanted.has(g.playerId));
    const id=m.apiId.replace('espn_','');
    const c=await getJson(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${m.compId}/events/${id}/competitions/${id}?lang=en&region=us`);
    const out=[];let complete=true;
    for(const team of c?.competitors||[]){
      if(!team.roster?.$ref){complete=false;continue;}
      const roster=await getJson(team.roster.$ref.replace('http:','https:'));
      if(!roster?.entries){complete=false;continue;}
      const entries=roster.entries.filter(e=>e.period===0 && e.starter===true && e.statistics?.$ref);
      out.push(...(await pool(entries,6,async e=>{
        const d=await getJson(e.statistics.$ref.replace('http:','https:'));
        if(!d?.splits?.categories){complete=false;return null;}
        const stats=d.splits.categories.flatMap(c=>c.stats||[]);
        const value=name=>{const v=stats.find(s=>s.name===name)?.value;return Number.isFinite(v)?v:null;};
        const minutes=value('minutes');if(!(minutes>0))return null;
        return {eventId:m.apiId,compId:m.compId,date:m.date,team:team.homeAway==='home'?m.h:m.a,opponent:team.homeAway==='home'?m.a:m.h,playerId:String(e.playerId),starter:e.starter===true,minutes,shots:value('totalShots'),sot:value('shotsOnTarget')};
      })).filter(Boolean));
    }
    if(complete&&out.length)cache[m.apiId]={version:2,rows:out};
    return out.filter(g=>wanted.has(g.playerId));
  })).flat();
  // Keep only this window in the persistent cache; failed requests are retried.
  const keys=new Set(selected.map(m=>m.apiId));cache=Object.fromEntries(Object.entries(cache).filter(([k])=>keys.has(k)));
  await mkdir('.cache',{recursive:true});await writeFile('.cache/player-games.json',JSON.stringify(cache));
  console.error(`Player match history: ${rows.length} rows, ${selected.length} fixtures`);
  return rows;
}
