import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectPlayerHistory} from './player-history.mjs';

const original=process.cwd();
const dir=await mkdtemp(join(tmpdir(),'wk-history-test-'));
process.chdir(dir);
try {
  const match={apiId:'espn_test',compId:'eng.1',finished:true,date:'2026-10-01',h:'A',a:'B',playerRosterRefs:[{homeAway:'home',roster:{$ref:'http://fixture/roster'}}]};
  const player={playerId:'espn_2026_1',apps:6,shotsAvg:2};
  let requests=0;
  const get=async url=>{
    requests++;
    if(url==='http://fixture/roster')return {entries:[{period:0,starter:true,playerId:1,statistics:{$ref:'http://fixture/stats'}}]};
    if(url==='http://fixture/stats')return {splits:{categories:[{stats:[{name:'minutes',value:80},{name:'totalShots',value:0}]}]}};
    throw new Error(`Unexpected reference ${url}`);
  };
  const pool=async (items,limit,fn)=>Promise.all(items.map(fn));
  const rows=await collectPlayerHistory([match],[player],get,pool);
  assert.equal(rows.length,1);
  assert.equal(rows[0].shots,0);
  assert.equal(rows[0].sot,null);
  assert.equal(rows[0].team,'A');
  assert.equal(requests,2);
  const cached=await collectPlayerHistory([match],[player],get,pool);
  assert.deepEqual(cached,rows);
  assert.equal(requests,2);
  console.log('Passed: provider references, real zeros vs missing stats, team mapping and cache reuse.');
} finally {process.chdir(original);}
