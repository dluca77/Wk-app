import {mkdir,writeFile} from 'node:fs/promises';
import {collectPlayerHistory} from './player-history.mjs';
async function getJson(url){try{const r=await fetch(url,{signal:AbortSignal.timeout(20000)});return r.ok?await r.json():null;}catch{return null;}}
async function pool(items,limit,fn){const out=[];let i=0;await Promise.all(Array.from({length:limit},async()=>{while(i<items.length){const j=i++;out[j]=await fn(items[j]);}}));return out;}
const base='https://wk2026-proxy.isaak-elia.workers.dev';
const [matches,players]=await Promise.all([getJson(base+'/matches'),getJson(base+'/players')]);
if(!matches?.matches||!players?.players)throw new Error('Cannot read current fixtures and players');
const rows=await collectPlayerHistory(matches.matches,players.players,getJson,pool);
if(!rows.length)throw new Error('No player history available');
await mkdir('data',{recursive:true});
await writeFile('data/player-history.json',JSON.stringify({fetchedAt:new Date().toISOString(),source:'ESPN core event roster statistics',rows}));
console.error(`Saved ${rows.length} actual player-game observations`);
