const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const worker = fs.readFileSync('worker/index.js', 'utf8').split('export default')[0];
const context = vm.createContext({});
vm.runInContext(worker, context);
const match = {h:'Home', a:'Away', compName:'Premier League'};
const standing = (team, gf, ga) => ({team, compName:match.compName, played:10, gf, ga});
const build = (table, players = [], lineups = null) => context.buildMatchBase(match, table, players, lineups);
assert.equal(build([]).model.available, false);
const table = [standing('Home', 22, 8), standing('Away', 9, 21)];
const good = build(table).model;
assert.equal(good.available, true);
assert.ok(good.pHome > good.pAway);
assert.ok(Math.abs(good.pHome + good.pDraw + good.pAway - 1) < 1e-12);
assert.equal(build(table.map(s=>({...s, compName:'Other'}))).model.available, false);
assert.equal(build([table[0], {...table[1], gf:null}]).model.available, false);
assert.equal(build([table[0], {...table[1], played:2}]).model.available, false);
const players = [{playerId:'espn_1',name:'Player',team:'Home',compName:match.compName,apps:5,mins:400,shots:20}];
assert.equal(build(table, players, {home:[2],away:[]}).homePlayers.length, 0);
assert.equal(build(table, players).homePlayers.length, 1);
const html = fs.readFileSync('index.html','utf8');
for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
vm.runInContext(html.slice(html.indexOf('const TIER0_ORDER'), html.indexOf('function matchesStatusFilter')), context);
assert.ok(context.compSortKey('English Premier League','eng.1') < context.compSortKey('Dutch Eredivisie','ned.1'));
assert.ok(context.compSortKey('Spanish LALIGA','esp.1') < context.compSortKey('UEFA Europa League','uefa.europa'));
console.log('Passed: evidence gating, competition isolation, missing values, probability normalization, lineup filtering, priority ordering and browser script syntax.');
const history = [
  {apiId:'1',h:'Home',a:'Away',date:'2026-10-01',finished:true,result:'2-0',compId:'eng.1'},
  {apiId:'1',h:'Home',a:'Away',date:'2026-10-01',finished:true,result:'2-0',compId:'eng.1'},
  {apiId:'2',h:'Other',a:'Home',date:'2026-10-10',finished:true,result:'1-1',compId:'eng.1'},
  {apiId:'3',h:'Home',a:'Other',date:'2026-10-16',finished:true,result:'9-0',compId:'eng.1'},
  {apiId:'4',h:'Home',a:'Other',date:'2026-10-12',finished:true,result:'0-1',compId:'cup'},
];
const form = context.recentTeamForm(history,{date:'2026-10-16',compId:'eng.1'},'Home','home');
assert.equal(form.recent.played,2);
assert.equal(form.recent.goalsFor,3);
assert.equal(form.recent.points,4);
assert.equal(form.venue.played,1);
assert.equal(form.daysSinceLastKnownMatch,4);
assert.equal(context.recentTeamForm([], {date:'2026-10-16'},'Home','home').daysSinceLastKnownMatch,null);
console.log('Passed: recent form, duplicate fixtures, competition/venue separation, same-day exclusion, latest known match and missing history.');
vm.runInContext(html.slice(html.indexOf('function quickMatchPicks'),html.indexOf('function renderQuickPicks')),context);
const emptyPicks=context.quickMatchPicks({model:{available:false},players:{home:[],away:[]}});
assert.equal(emptyPicks.length,4);
assert.ok(emptyPicks.every(p=>p.probability===null));
const picks=context.quickMatchPicks({model:{available:true,lambdaHome:1.5,lambdaAway:1},players:{home:[{name:'A',apps:10,shotsAvg:3,sotAvg:1.2,starter:true}],away:[]}});
assert.equal(picks[0].title,'A · 2+ schoten');
assert.equal(picks[1].title,'A · 1+ schoten op doel');
assert.equal(picks[2].title,'Nee');
assert.equal(picks[3].title,'Under 2,5 goals');
assert.ok(picks[3].probability>.5 && picks[3].probability<1);
console.log('Passed: quick picks, player thresholds, missing data and Poisson markets.');
