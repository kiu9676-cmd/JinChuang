/* ai.js — 空位补位 AI / 15 秒托管决策（启发式，无搜索，零依赖） */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.MJ = root.MJ || {};
  root.MJ.AI = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var T = (typeof module !== 'undefined' && module.exports)
    ? require('./tiles.js')
    : ((typeof window !== 'undefined' ? window : globalThis).MJ.Tiles);
  var E = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : ((typeof window !== 'undefined' ? window : globalThis).MJ.Engine);

  function rnd(rng) { return rng ? rng() : Math.random(); }

  /* 定缺：选张数最少、对子/搭子最弱的一门 */
  function chooseLack(hand) {
    var counts = T.toCounts(hand);
    var stat = [{ n: 0, pair: 0, near: 0 }, { n: 0, pair: 0, near: 0 }, { n: 0, pair: 0, near: 0 }];
    for (var id = 0; id < T.KINDS; id++) {
      var c = counts[id];
      if (!c) continue;
      var s = T.suitOf(id), r = id % 9, st = stat[s];
      st.n += c;
      if (c >= 2) st.pair++;
      if (r >= 1 && counts[id - 1] > 0) st.near++;
      if (r <= 7 && counts[id + 1] > 0) st.near++;
    }
    var best = 0, bestScore = Infinity;
    for (var k = 0; k < 3; k++) {
      var score = stat[k].n * 1.0 + stat[k].pair * 1.9 + stat[k].near * 0.7;
      if (score < bestScore) { bestScore = score; best = k; }
    }
    return best;
  }

  /* 出牌：先打缺门，再打最孤立的张；保留对子与搭子 */
  function chooseDiscard(g, seat, rng) {
    var p = g.players[seat], hand = p.hand;
    if (!hand || !hand.length) return -1;
    var counts = T.toCounts(hand), candidates = [];
    for (var id = 0; id < T.KINDS; id++) if (counts[id] > 0) candidates.push(id);
    if (p.lack >= 0) {
      var lackCards = [];
      for (var i = 0; i < candidates.length; i++)
        if (T.suitOf(candidates[i]) === p.lack) lackCards.push(candidates[i]);
      if (lackCards.length) candidates = lackCards;
    }
    function keepValue(id) {
      var r = id % 9, v = counts[id] * 3 + (counts[id] >= 2 ? 4 : 0);
      if (r >= 1) v += counts[id - 1] * 1.6;
      if (r <= 7) v += counts[id + 1] * 1.6;
      if (r >= 2) v += counts[id - 2] * 0.7;
      if (r <= 6) v += counts[id + 2] * 0.7;
      return v;
    }
    var best = candidates[0], bestVal = Infinity;
    for (var j = 0; j < candidates.length; j++) {
      var val = keepValue(candidates[j]) + rnd(rng) * 0.4;
      if (val < bestVal) { bestVal = val; best = candidates[j]; }
    }
    return best;
  }

  /* 响应碰/杠/胡：能胡必胡，其余按启发概率 */
  function chooseClaim(g, seat, options, tile, rng) {
    if (options.indexOf('win') >= 0) return 'win';
    var r = rnd(rng);
    if (options.indexOf('gang') >= 0 && r < 0.55) return 'gang';
    if (options.indexOf('peng') >= 0 && r < 0.42) return 'peng';
    return 'pass';
  }

  /* 自己回合：胡 > 有概率杠 > 出牌 */
  function chooseTurn(g, seat, rng) {
    var actor = null, actors = E.neededActors(g);
    for (var i = 0; i < actors.length; i++)
      if (actors[i].seat === seat && actors[i].kind === 'turn') { actor = actors[i]; break; }
    if (actor && actor.options) {
      for (var k = 0; k < actor.options.length; k++)
        if (actor.options[k].type === 'win' && actor.options[k].ok) return { type: 'win' };
    }
    if (actor && actor.kongs && actor.kongs.length && rnd(rng) < 0.45) {
      var kg = actor.kongs[0];
      return { type: 'kong', tile: kg.tile, kind: kg.kind };
    }
    return { type: 'discard', tile: chooseDiscard(g, seat, rng) };
  }

  /* 统一入口：把 neededActors 的一项翻译成 action */
  function autoAction(g, actor, rng) {
    if (!actor) return null;
    if (actor.kind === 'lack') return { type: 'lack', suit: chooseLack(g.players[actor.seat].hand) };
    if (actor.kind === 'claim') return { type: 'claim', choice: chooseClaim(g, actor.seat, actor.options, actor.tile, rng) };
    return chooseTurn(g, actor.seat, rng);
  }

  function createPacer(random) {
    var key = '', due = 0;
    return {
      ready: function(decision, kind, now) {
        if (!decision) { key = ''; return false; }
        if (key !== decision) {
          key = decision;
          var timing = kind === 'turn' ? [1750, 1150] : kind === 'claim' ? [950, 650] : [900, 650];
          due = now + timing[0] + timing[1] * rnd(random);
        }
        return now >= due;
      }
    };
  }

  return {
    createPacer: createPacer, chooseLack: chooseLack, chooseDiscard: chooseDiscard, chooseClaim: chooseClaim,
    chooseTurn: chooseTurn, autoAction: autoAction
  };
});
