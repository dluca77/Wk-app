const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ctx=vm.createContext({fetch,Date,console});
vm.runInContext(fs.readFileSync('worker/index.js','utf8').split('export default')[0],ctx);
const env={WK_CACHE:{get:async()=>null,put:async()=>{}}};
(async()=>{
  assert.equal(ctx.quoteFreshness(null),'unknown');
  assert.equal(ctx.quoteFreshness(new Date().toISOString()),'recent');
  assert.equal(ctx.quoteFreshness('2020-01-01'),'stale');
  const fixture={items:[{provider:{name:'DraftKings'},overUnder:2.5,homeTeamOdds:{current:{moneyLine:{decimal:2.1}}},awayTeamOdds:{current:{moneyLine:{decimal:3.55}}},current:{draw:{decimal:3.45},over:{decimal:1.9},under:{decimal:1.9}}}]};
  ctx.fetch=async()=>({ok:true,json:async()=>fixture});
  const o=await ctx.fetchOdds(env,'espn_1','esp.1');
  assert.equal(o.home,2.1);assert.equal(o.draw,3.45);assert.equal(o.away,3.55);assert.equal(o.overOdds,1.9);assert.equal(o.freshness,'unknown');
  ctx.fetch=async()=>({ok:false,status:503});
  assert.equal((await ctx.fetchOdds(env,'espn_1','esp.1')).status,'fetch_failed');
  assert.equal((await ctx.fetchPlayerProps(env,'espn_1','esp.1',[])).status,'fetch_failed');
  assert.equal((await ctx.fetchPlayerProps(env,'bad','esp.1',[])).players.length,0);
  const saved={eventId:'1',fetchedAt:Date.now(),odds:fixture,props:{items:[],pageCount:1}};
  const stored={WK_CACHE:{get:async key=>key==='market_document_1'?saved:null,put:async()=>{}}};
  // Network remains unavailable: ingestion snapshot must still serve quotes.
  assert.equal((await ctx.fetchOdds(stored,'espn_1','esp.1')).home,2.1);
  saved.fetchedAt=Date.now()-31*60*1000;
  assert.equal((await ctx.fetchOdds(stored,'espn_1','esp.1')).status,'fetch_failed');
  ctx.fetch=fetch;
  if(process.argv.includes('--live')){
    const live=await ctx.fetchOdds(env,'espn_401882844','esp.1');
    assert.ok(live.home>1 && live.draw>1 && live.away>1);
    const props=await ctx.fetchPlayerProps(env,'espn_401882844','esp.1',[{playerId:'espn_90_186024',name:'Fixture player'}]);
    assert.ok(props.players.some(p=>p.markets.some(m=>m.line==='3+')));
    assert.equal(props.btts,null); // ESPN supplies no verifiable yes/no labels.
    console.log(JSON.stringify({liveOdds:live,propStatus:props.status,markets:props.players[0]?.markets.length}));
  }
  console.log('Odds checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
