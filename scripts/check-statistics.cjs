const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ctx=vm.createContext({Date});vm.runInContext(fs.readFileSync('worker/index.js','utf8').split('export default')[0],ctx);
const match={h:'A',a:'B',compId:'eng.1',compName:'Premier League',date:'2026-10-16'};
const rows=Array.from({length:30},(_,i)=>({apiId:String(i),h:i%2?'C':'A',a:i%2?'B':'D',compId:'eng.1',date:`2026-09-${String(i+1).padStart(2,'0')}`,finished:true,result:i%2?'1-2':'2-1'}));
const model=ctx.historicalGoalModel(match,rows);
assert.equal(model.available,true);assert.ok(Math.abs(model.pHome+model.pAway+model.pDraw-1)<1e-12);
const leaked=[...rows,{...rows[0],apiId:'future',date:'2026-10-17',result:'20-0'},rows[0]];
assert.equal(ctx.historicalGoalModel(match,leaked).lambdaHome,model.lambdaHome);
const player={playerId:'espn_2026_1',name:'Player',team:'A',compName:'Premier League'};
const history=Array.from({length:8},(_,i)=>({eventId:String(i),date:`2026-09-${10+i}`,compId:'eng.1',team:'A',playerId:'1',starter:true,minutes:75,shots:i<6?3:1,sot:i<5?1:0}));
const picks=ctx.statisticalPicks(match,model,[player],history,null);
assert.ok(picks[0].probability>0 && picks[0].probability<1);
assert.ok(picks[0].lower<picks[0].probability&&picks[0].upper>picks[0].probability);
assert.equal(ctx.statisticalPicks(match,model,[player],history.slice(0,4),null)[0].probability,null);
assert.equal(ctx.statisticalPicks(match,model,[player],history,{home:[2],away:[]})[0].probability,null);
const quoted=ctx.attachQuoteChecks(picks,[{name:'Player',markets:[{type:'Shots Milestones',line:'2+',odds:10,freshness:'recent'}]}],null);
assert.equal(quoted[0].probability,picks[0].probability);assert.equal(quoted[0].title,picks[0].title);
assert.equal(ctx.attachQuoteChecks(picks,[{name:'Player',markets:[{type:'Shots Milestones',line:'1+',odds:10,freshness:'recent'}]}],null)[0].valueCheck.status,'no_verified_current_quote');
console.log('Statistics checks passed: no future leakage, deduplication, sample gates, lineup exclusion, uncertainty, exact-line odds and odds-independent selection.');
if(process.argv.includes('--backtest')) (async()=>{
 const data=await(await fetch('https://wk2026-proxy.isaak-elia.workers.dev/matches')).json();
 const all=data.matches.filter(m=>m.finished&&['eng.1','esp.1','ita.1','ger.1','fra.1','ned.1'].includes(m.compId)).sort((a,b)=>a.date.localeCompare(b.date));
 let n=0,brier=0,baseline=0;
 for(const m of all){const p=ctx.historicalGoalModel(m,all);if(!p.available)continue;
   const [h,a]=m.result.split('-').map(Number),truth=h>a?0:h===a?1:2;
   brier+=[p.pHome,p.pDraw,p.pAway].reduce((s,v,i)=>s+(v-(i===truth?1:0))**2,0);baseline+=2/3;n++;
 }
 console.log(JSON.stringify({test:'chronological six-league replay; only earlier dates',matches:n,multiclassBrier:n?brier/n:null,uniformBaseline:n?baseline/n:null,calibration:'not established; parameters not tuned on this test'}));
})().catch(e=>{console.error(e);process.exitCode=1});
