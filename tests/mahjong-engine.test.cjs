const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../web/games/majiang/assets/js/engine.js');
const T = require('../web/games/majiang/assets/js/tiles.js');
const AI = require('../web/games/majiang/assets/js/ai.js');
let seq = 0;
const act = (g, seat, action) => E.applyAction(g, { seat, seq: ++seq, action });
function seeded(seed) { return () => ((seed = (Math.imul(seed,1664525)+1013904223) >>> 0) / 2**32); }
function setup() {
  const g = E.createGame({rng:seeded(45)});
  E.startRound(g);
  for (let s=0;s<4;s++) assert.ok(act(g,s,{type:'lack',suit:s%3}).ok);
  return g;
}

test('发牌正确，公开视图不包含刚摸到的牌值', () => {
  const g=E.createGame({rng:seeded(12)});
  E.startRound(g);
  assert.equal(g.phase,'lack');
  assert.deepEqual(g.players.map(p=>p.hand.length),[14,13,13,13]);
  assert.equal(g.wall.length,55);
  assert.deepEqual(T.toCounts(g.wall.concat(...g.players.map(p=>p.hand))),new Array(27).fill(4));
  assert.equal(E.getView(g,null).lastDraw.tile,undefined);
  assert.equal(E.getView(g,1).lastDraw.tile,undefined);
  assert.equal(E.getView(g,0).myDrawn,g.lastDraw.tile);
});
test('定缺与出牌限制，非法动作不改手牌', () => {
  const g=setup();
  g.players[0].hand=[0,9,10,11,12,13,14,15,16,17,17,17,17,18];
  const before=g.players[0].hand.slice();
  assert.equal(act(g,0,{type:'discard',tile:9}).ok,false);
  assert.deepEqual(g.players[0].hand,before);
  assert.ok(act(g,0,{type:'discard',tile:0}).ok);
  E.startRound(g);
  assert.equal(act(g,0,{type:'lack',suit:1.5}).ok,false);
});
test('已响应的碰杠胡选项不会继续显示', () => {
  const g=setup();
  g.phase='claim';
  g.pending={from:0,tile:9,opts:{1:['peng'],2:['win']},responses:{}};
  assert.deepEqual(E.getView(g,1).myOptions,['peng']);
  assert.ok(act(g,1,{type:'claim',choice:'pass'}).ok);
  assert.deepEqual(E.getView(g,1).myOptions,[]);
  assert.deepEqual(E.neededActors(g).map(p=>p.seat),[2]);
});
test('暗杠受缺门与牌墙限制，抢补杠仅允许胡并还原为碰', () => {
  const g=setup();
  g.players[0].lack=2;
  g.players[0].hand=[17,18,18,18,18,4,5,6,7,8,9];
  g.players[0].melds=[{type:'peng',tid:17,n:3,from:3}];
  g.players[1].lack=2;
  g.players[1].hand=[0,1,2,3,4,5,9,10,11,15,16,8,8];
  g.players[2].hand=[]; g.players[3].hand=[];
  assert.equal(E.getView(g,0).myKongs.some(x=>x.tile===18),false);
  assert.equal(act(g,0,{type:'kong',kind:'concealed',tile:18}).ok,false);
  assert.ok(act(g,0,{type:'kong',kind:'added',tile:17}).ok);
  assert.deepEqual(E.getView(g,1).myOptions,['win']);
  assert.ok(act(g,1,{type:'claim',choice:'win'}).ok);
  assert.equal(g.players[0].melds[0].type,'peng');
  assert.equal(g.players[0].hand.includes(17),false);
  assert.equal(g.wins[0].seat,1);
});
test('练习提示只使用明牌和自己的牌，并按未见张数排序', () => {
  const g=setup();
  g.players[0].lack=2;
  g.players[0].hand=[0,1,2,3,4,5,9,10,11,12,13,14,17,17];
  g.river[1]=[17];
  const hints=E.discardHints(g,0);
  assert.equal(hints.find(x=>x.discard===17).waits.find(w=>w.id===17).remaining,1);
  assert.equal(E.discardHints(g,1).length,0);
  g.wall=[]; g.players[1].hand=[0,1];
  assert.deepEqual(E.discardHints(g,0),hints);
  assert.ok(hints.every((x,i)=>i===0||x.total<=hints[i-1].total));
});
test('模拟 80 局：AI 不会卡住，结算零和，仅房主可开下一局', () => {
  for (let seed=1;seed<=80;seed++) {
    const g=E.createGame({rng:seeded(seed)});
    E.startRound(g);
    assert.equal(act(g,0,{type:'next'}).ok,false);
    for (let n=0;n<380 && g.phase!=='settle';n++) {
      const [next]=E.neededActors(g);
      assert.ok(next,'need an actor for '+g.phase+' (seed '+seed+')');
      const result=act(g,next.seat,AI.autoAction(g,next,g.rng));
      assert.ok(result.ok,JSON.stringify({seed,result,next}));
    }
    assert.equal(g.phase,'settle','seed '+seed);
    assert.equal(g.players.reduce((sum,p)=>sum+p.score,0),0);
    assert.equal(act(g,1,{type:'next'}).ok,false);
    const prior=g.players.map(p=>p.score);
    assert.ok(act(g,0,{type:'next'}).ok);
    assert.deepEqual(E.getView(g,0).roundStartScores,prior);
  }
});


test('AI 出牌等待真实思考时间，决策换人会重置计时', () => {
  const pace = AI.createPacer(() => 0.5);
  assert.equal(pace.ready('round-1:seat-1','turn',100),false);
  assert.equal(pace.ready('round-1:seat-1','turn',2400),false);
  assert.equal(pace.ready('round-1:seat-1','turn',2425),true);
  assert.equal(pace.ready('round-1:seat-2','turn',2425),false);
  assert.equal(pace.ready('round-1:seat-2','turn',4750),true);
  assert.equal(pace.ready('','turn',4800),false);
  assert.equal(pace.ready('round-1:seat-2','turn',4900),false);
});
