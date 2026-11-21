/* engine.js — 四川麻将「血战到底」权威规则引擎（房主侧运行，纯逻辑，可在 node 下单测）
   规则：108 张 / 定缺 / 碰杠 / 抢杠胡 / 血战到底 / 一炮多响 / 番型封顶 / 查大叫 / 庄家轮转
   所有状态变更经由 applyAction 统一入口，seq 幂等。 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.MJ = root.MJ || {};
  root.MJ.Engine = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var T = (typeof module !== 'undefined' && module.exports)
    ? require('./tiles.js')
    : ((typeof window !== 'undefined' ? window : globalThis).MJ.Tiles);

  var SUIT_CN = ['万', '条', '筒'];
  function validTile(id) { return Number.isInteger(id) && id >= 0 && id < 27; }
  function sum(c) { var s = 0; for (var i = 0; i < c.length; i++) s += c[i]; return s; }
  function firstNonZero(c) { for (var i = 0; i < c.length; i++) if (c[i] > 0) return i; return -1; }

  /* ---------------- 游戏创建与开局 ---------------- */
  function createGame(cfg) {
    cfg = cfg || {};
    var g = {
      room: cfg.room || '0000',
      hostSeat: cfg.hostSeat == null ? 0 : cfg.hostSeat,
      round: 1,
      dealer: 0,
      nextDealer: 0,
      phase: 'init',              // init | lack | play | claim | settle | over
      current: 0,
      wall: [],
      wallRemaining: 0,
      players: [],
      river: [[], [], [], []],
      lastDiscard: null,
      lastDraw: null,
      pending: null,
      seq: 0,
      seen: Object.create(null),  // "seat:seq" 幂等表
      wins: [],
      events: [],
      config: {
        maxFan: cfg.maxFan || 8,
        base: cfg.base || 1,
        timeout: cfg.timeout || 15,
        chaDaJiao: cfg.chaDaJiao !== false
      },
      rng: cfg.rng || Math.random,
      finished: false
    };
    for (var s = 0; s < 4; s++) {
      g.players.push({
        seat: s, name: cfg.names && cfg.names[s] ? cfg.names[s] : ('玩家' + (s + 1)),
        avatarKey: 'fox', online: true, ai: false, score: 0, hand: [], melds: [], lack: -1,
        winner: false, retired: false, ting: null, drawnTile: null
      });
    }
    return g;
  }

  function emit(g, type, data) {
    var e = { type: type };
    if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) e[k] = data[k];
    g.events.push(e);
    return e;
  }

  function aliveCount(g) {
    var n = 0;
    for (var i = 0; i < 4; i++) if (!g.players[i].winner && !g.players[i].retired) n++;
    return n;
  }
  function nextAlive(g, from) {
    for (var k = 1; k <= 4; k++) {
      var s = (from + k) % 4, p = g.players[s];
      if (!p.winner && !p.retired) return s;
    }
    return -1;
  }

  function startRound(g) {
    g.wall = T.shuffle(T.makeWall(), g.rng);
    g.wallRemaining = g.wall.length;
    g.river = [[], [], [], []];
    g.lastDiscard = null; g.lastDraw = null; g.pending = null;
    g.wins = []; g.events = []; g.finished = false;
    g.roundStartScores = g.players.map(function (p) { return p.score; });
    for (var s = 0; s < 4; s++) {
      var p = g.players[s];
      p.hand = []; p.melds = []; p.lack = -1;
      p.winner = false; p.retired = false; p.ting = null; p.drawnTile = null;
    }
    // 逐张轮流发 13 张（发牌动画按此顺序飞）
    var order = [];
    for (var n = 0; n < 13; n++) for (var i = 0; i < 4; i++) {
      var seat = (g.dealer + i) % 4;
      var tile = g.wall.pop();
      g.players[seat].hand.push(tile);
      order.push({ seat: seat, tile: tile, index: n * 4 + i });
    }
    // 庄家先摸一张（14 张起手）
    var first = g.wall.pop();
    g.players[g.dealer].hand.push(first);
    g.wallRemaining = g.wall.length;
    g.lastDraw = { seat: g.dealer, tile: first, kongFlower: false, lastTile: false };
    g.players[g.dealer].drawnTile = first;
    g.current = g.dealer;
    g.phase = 'lack';
    g.seq++;
    emit(g, 'deal', { order: order, dealer: g.dealer, round: g.round });
    return g;
  }

  function setPlayer(g, seat, patch) {
    if (seat < 0 || seat > 3) return false;
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) g.players[seat][k] = patch[k];
    return true;
  }

  /* ---------------- 定缺 ---------------- */
  function setLack(g, seat, suit) {
    if (g.phase !== 'lack') return fail('INVALID_ACTION', '当前不是定缺阶段');
    if (seat < 0 || seat > 3) return fail('INVALID_ACTION', '座位无效');
    if (!Number.isInteger(suit) || !(suit >= 0 && suit <= 2)) return fail('INVALID_ACTION', '缺门只能是万/条/筒');
    var p = g.players[seat];
    if (p.lack >= 0) return fail('INVALID_ACTION', '已经定过缺了');
    p.lack = suit;
    g.seq++;
    emit(g, 'lack', { seat: seat, suit: suit });
    var all = true;
    for (var i = 0; i < 4; i++) if (g.players[i].lack < 0 && !g.players[i].retired) { all = false; break; }
    if (all) beginPlay(g);
    return ok();
  }

  function beginPlay(g) {
    g.phase = 'play';
    g.current = g.dealer;
    if (g.players[g.current].retired) { drawFor(g,nextAlive(g,g.current),{}); return; }
    g.seq++;
    emit(g, 'turn', { seat: g.current });
  }

  /* ---------------- 摸牌 ---------------- */
  function drawFor(g, seat, ctx) {
    ctx = ctx || {};
    if (!g.wall.length) { endRound(g, 'wall_empty'); return false; }
    var tile = g.wall.pop();
    g.wallRemaining = g.wall.length;
    var p = g.players[seat];
    p.hand.push(tile);
    p.drawnTile = tile;
    g.lastDraw = {
      seat: seat, tile: tile, stamp: g.seq + 1,
      kongFlower: !!ctx.kongFlower,
      lastTile: g.wall.length === 0
    };
    g.current = seat;
    g.phase = 'play';
    g.seq++;
    emit(g, 'draw', { seat: seat, tile: tile, kongFlower: !!ctx.kongFlower, lastTile: g.wall.length === 0 });
    emit(g, 'turn', { seat: seat });
    return true;
  }

  /* ---------------- 打牌与响应窗口 ---------------- */
  function discard(g, seat, tile) {
    if (g.phase !== 'play') return fail('INVALID_ACTION', '当前不能出牌');
    if (g.current !== seat) return fail('NOT_YOUR_TURN', '还没轮到你');
    var p = g.players[seat];
    if (!validTile(tile) || p.hand.indexOf(tile) < 0) return fail('INVALID_ACTION', '手里没有这张牌');
    if (p.lack >= 0 && T.hasLack(p.hand, p.lack) && !T.isLack(tile, p.lack))
      return fail('INVALID_ACTION', '必须先打完缺门牌');
    T.removeOne(p.hand, tile);
    p.drawnTile = null;
    g.river[seat].push(tile);
    g.lastDiscard = { seat: seat, tile: tile, stamp: g.seq + 1 };
    g.seq++;
    emit(g, 'discard', { seat: seat, tile: tile, wallEmpty: g.wall.length === 0 });
    checkClaims(g, seat, tile, false);
    return ok();
  }

  function checkClaims(g, fromSeat, tile, isRobKong, robber) {
    var opts = Object.create(null);
    for (var s = 0; s < 4; s++) {
      if (s === fromSeat) continue;
      var p = g.players[s];
      if (p.winner || p.retired) continue;
      var list = [];
      var w = checkWin(g, s, tile, {
        selfDraw: false, fromSeat: fromSeat, robKong: !!isRobKong,
        lastTile: g.wall.length === 0
      });
      if (w.win) list.push('win');
      var c = T.toCounts(p.hand);
      // 缺门牌不能碰/杠
      if (!isRobKong && !T.isLack(tile, p.lack)) {
        if (c[tile] >= 2) list.push('peng');
        if (c[tile] >= 3 && g.wall.length) list.push('gang');
      }
      if (list.length) opts[s] = list;
    }
    var any = false;
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) { any = true; break; }
    if (!any) {
      // 抢杠窗口无人能胡：交给补杠者完成杠并摸牌，不能让下家摸牌
      if (isRobKong) return;
      // 无人响应：下家摸牌；牌墙空则流局
      var next = nextAlive(g, fromSeat);
      if (next < 0 || !g.wall.length) { endRound(g, 'wall_empty'); return; }
      drawFor(g, next, {});
      return;
    }
    g.phase = 'claim';
    g.pending = {
      from: fromSeat, tile: tile, opts: opts, responses: Object.create(null),
      robKong: !!isRobKong, robber: robber == null ? fromSeat : robber,
      lastTile: g.wall.length === 0
    };
    g.seq++;
    emit(g, 'claim', { from: fromSeat, tile: tile, robKong: !!isRobKong });
  }

  function claim(g, seat, choice) {
    if (g.phase !== 'claim' || !g.pending) return fail('INVALID_ACTION', '当前没有可响应的牌');
    var pend = g.pending;
    var allow = pend.opts[seat];
    if (!allow || pend.responses[seat] !== undefined) return fail('INVALID_ACTION', '你不能响应这张牌');
    if (['win', 'peng', 'gang', 'pass'].indexOf(choice) < 0) return fail('INVALID_ACTION', '未知响应');
    if (choice !== 'pass' && allow.indexOf(choice) < 0) return fail('INVALID_ACTION', '不支持该响应');
    pend.responses[seat] = choice;
    g.seq++;
    emit(g, 'response', { seat: seat, choice: choice, tile: pend.tile });
    var total = 0;
    for (var k in pend.opts) if (Object.prototype.hasOwnProperty.call(pend.opts, k)) total++;
    var answered = 0;
    for (var k2 in pend.responses) if (Object.prototype.hasOwnProperty.call(pend.responses, k2)) answered++;
    if (answered >= total) resolvePending(g);
    return ok();
  }

  function resolvePending(g) {
    var pend = g.pending;
    if (!pend) return;
    g.pending = null;
    // 一炮多响：按座位顺序（从出牌者下家起）结算所有胡牌者
    var winners = [];
    for (var k = 1; k <= 4; k++) {
      var s = (pend.from + k) % 4;
      if (pend.responses[s] === 'win') winners.push(s);
    }
    // 抢杠胡成立：杠不成立，恢复为碰；第 4 张被胡牌者取走。
    if (winners.length && pend.robKong && pend.kongSeat != null) {
      var kp = g.players[pend.kongSeat];
      for (var mi = 0; mi < kp.melds.length; mi++) {
        var km = kp.melds[mi];
        if (km.type === 'bugang' && km.tid === pend.kongTile) {
          km.type = 'peng'; km.n = 3; km.robbable = false; break;
        }
      }
    }
    if (winners.length) {
      var ctx = {
        selfDraw: false,
        fromSeat: pend.robKong ? pend.robber : pend.from,
        robKong: pend.robKong,
        lastTile: pend.lastTile,
        tile: pend.tile
      };
      var results = [];
      for (var i = 0; i < winners.length; i++) {
        var w = checkWin(g, winners[i], pend.tile, ctx);
        results.push({ seat: winners[i], win: w });
      }
      settleWin(g, results, ctx);
      return;
    }
    // 抢杠窗口全员「过」：杠成立，补杠者摸一张（可能杠上花）
    if (pend.robKong && pend.kongSeat != null) {
      finishRobKong(g, pend);
      return;
    }
    // 杠 / 碰：优先级 gang > peng，同级按座位顺序
    var bestSeat = -1, bestType = null;
    for (var k3 = 1; k3 <= 4; k3++) {
      var s3 = (pend.from + k3) % 4;
      var r = pend.responses[s3];
      if (r === 'gang') { bestSeat = s3; bestType = 'gang'; break; }
      if (r === 'peng' && bestSeat < 0) { bestSeat = s3; bestType = 'peng'; }
    }
    if (bestSeat >= 0) {
      // 弃牌者牌河里收回该张（被碰/杠拿走）
      var arr = g.river[pend.from];
      if (arr.length && arr[arr.length - 1] === pend.tile) arr.pop();
      if (bestType === 'peng') doPeng(g, bestSeat, pend.tile, pend.from);
      else doMingGang(g, bestSeat, pend.tile, pend.from);
      return;
    }
    // 全部过：下家摸牌
    var next = nextAlive(g, pend.from);
    if (next < 0 || !g.wall.length) { endRound(g, 'wall_empty'); return; }
    g.phase = 'play';
    drawFor(g, next, {});
  }

  /* ---------------- 碰 / 杠 ---------------- */
  function doPeng(g, seat, tile, fromSeat) {
    var p = g.players[seat];
    var c = T.toCounts(p.hand);
    if (c[tile] < 2) return fail('INVALID_ACTION', '碰不了');
    T.removeOne(p.hand, tile); T.removeOne(p.hand, tile);
    p.melds.push({ type: 'peng', tid: tile, from: fromSeat, n: 3, robbable: false });
    p.drawnTile = null;
    g.current = seat; g.phase = 'play'; g.seq++;
    emit(g, 'peng', { seat: seat, tile: tile, from: fromSeat });
    emit(g, 'turn', { seat: seat });
    return ok();
  }

  function doMingGang(g, seat, tile, fromSeat) {
    var p = g.players[seat];
    var c = T.toCounts(p.hand);
    if (c[tile] < 3) return fail('INVALID_ACTION', '杠不了');
    for (var i = 0; i < 3; i++) T.removeOne(p.hand, tile);
    p.melds.push({ type: 'minggang', tid: tile, from: fromSeat, n: 4, robbable: false });
    g.seq++;
    emit(g, 'gang', { seat: seat, tile: tile, kind: 'minggang', from: fromSeat });
    drawFor(g, seat, { kongFlower: true });
    return ok();
  }

  function doConcealedKong(g, seat, tid) {
    if (g.phase !== 'play' || g.current !== seat) return fail('NOT_YOUR_TURN', '还没轮到你');
    var p = g.players[seat], c = T.toCounts(p.hand);
    if (!validTile(tid) || !g.wall.length || T.isLack(tid, p.lack))
      return fail('INVALID_ACTION', '这张牌当前不可杠');
    if (c[tid] < 4) return fail('INVALID_ACTION', '暗杠需要四张相同');
    for (var i = 0; i < 4; i++) T.removeOne(p.hand, tid);
    p.melds.push({ type: 'angang', tid: tid, from: seat, n: 4, robbable: false });
    g.seq++;
    emit(g, 'gang', { seat: seat, tile: tid, kind: 'angang' });
    drawFor(g, seat, { kongFlower: true });
    return ok();
  }

  function doAddedKong(g, seat, tid) {
    if (g.phase !== 'play' || g.current !== seat) return fail('NOT_YOUR_TURN', '还没轮到你');
    var p = g.players[seat], c = T.toCounts(p.hand);
    if (!validTile(tid) || !g.wall.length || T.isLack(tid, p.lack))
      return fail('INVALID_ACTION', '这张牌当前不可杠');
    if (c[tid] < 1) return fail('INVALID_ACTION', '手里没有这张牌');
    var m = null;
    for (var i = 0; i < p.melds.length; i++)
      if (p.melds[i].type === 'peng' && p.melds[i].tid === tid) { m = p.melds[i]; break; }
    if (!m) return fail('INVALID_ACTION', '没有可补杠的碰');
    // 补杠可被抢杠胡：先开响应窗口
    T.removeOne(p.hand, tid);
    m.type = 'bugang'; m.n = 4; m.robbable = true;
    g.seq++;
    emit(g, 'kongTry', { seat: seat, tile: tid });
    checkClaims(g, seat, tid, true, seat);
    if (g.pending) {
      // 有人能抢杠胡：把牌暂挂，等待响应
      g.pending.kongSeat = seat;
      g.pending.kongTile = tid;
      return ok();
    }
    // 无人抢杠：杠成立，摸一张（杠上花）
    emit(g, 'gang', { seat: seat, tile: tid, kind: 'bugang' });
    drawFor(g, seat, { kongFlower: true });
    return ok();
  }

  function finishRobKong(g, fromPend) {
    var pend = fromPend || g.pending;
    if (!pend || pend.kongSeat == null || pend.kongTile == null) return;
    var seat = pend.kongSeat, tid = pend.kongTile;
    g.pending = null;
    var p = g.players[seat];
    var m = null;
    for (var i = 0; i < p.melds.length; i++)
      if (p.melds[i].type === 'bugang' && p.melds[i].tid === tid) { m = p.melds[i]; break; }
    if (m) m.robbable = false;
    emit(g, 'gang', { seat: seat, tile: tid, kind: 'bugang' });
    drawFor(g, seat, { kongFlower: true });
  }

  /* ---------------- 胡牌判定与番型 ---------------- */
  function stripMelds(c, need, tripletsOnly) {
    if (need === 0) return sum(c) === 0;
    var i = firstNonZero(c);
    if (i < 0) return false;
    if (c[i] >= 3) {
      c[i] -= 3;
      if (stripMelds(c, need - 1, tripletsOnly)) { c[i] += 3; return true; }
      c[i] += 3;
    }
    var r = i % 9;
    if (!tripletsOnly && r <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      if (stripMelds(c, need - 1, tripletsOnly)) { c[i]++; c[i + 1]++; c[i + 2]++; return true; }
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
    return false;
  }
  function canStandard(c, need) {
    if (sum(c) !== need * 3 + 2) return false;
    for (var i = 0; i < 27; i++) if (c[i] >= 2) {
      c[i] -= 2;
      var okk = stripMelds(c, need, false);
      c[i] += 2;
      if (okk) return true;
    }
    return false;
  }
  function canAllTriplets(c, need) {
    if (sum(c) !== need * 3 + 2) return false;
    for (var i = 0; i < 27; i++) if (c[i] >= 2) {
      c[i] -= 2;
      var okk = stripMelds(c, need, true);
      c[i] += 2;
      if (okk) return true;
    }
    return false;
  }
  function canSevenPairs(c) {
    if (sum(c) !== 14) return false;
    for (var i = 0; i < 27; i++) if (c[i] % 2 !== 0) return false;
    return true;
  }

  /* 纯函数：判定 seat 在 extra（点炮/抢杠牌，自摸传 null）下能否胡 */
  function checkWin(g, seat, extra, ctx) {
    ctx = ctx || {};
    var p = g.players[seat];
    if (!p || p.winner || p.retired) return { win: false };
    if (p.lack < 0) return { win: false };              // 未定缺不能胡
    var full = p.hand.slice();
    if (extra != null && extra >= 0) full.push(extra);
    // 定缺：手里（含副露）不能留缺门牌
    if (T.hasLack(full, p.lack)) return { win: false };
    for (var m = 0; m < p.melds.length; m++) if (T.suitOf(p.melds[m].tid) === p.lack) return { win: false };

    var meldCount = p.melds.length;
    var gangCount = 0;
    for (var m2 = 0; m2 < p.melds.length; m2++) if (p.melds[m2].n === 4) gangCount++;
    var need = 4 - meldCount;
    if (need < 0) return { win: false };
    var c = T.toCounts(full);
    // 杠的 4 张里多出的 1 张算「根」，不占手牌张数；
    // 胡牌时手牌恒为 14 - 3*m 张（m = 副露数），与杠数无关。
    var expected = need * 3 + 2;
    if (sum(c) !== expected) return { win: false };

    var standard = canStandard(c, need);
    var seven = (meldCount === 0 && gangCount === 0) ? canSevenPairs(c.slice()) : false;
    if (!standard && !seven) return { win: false };

    // 清一色
    var oneSuit = true, firstSuit = -1;
    for (var i = 0; i < full.length; i++) {
      var su = T.suitOf(full[i]);
      if (firstSuit < 0) firstSuit = su; else if (su !== firstSuit) { oneSuit = false; break; }
    }
    if (oneSuit) for (var q = 0; q < p.melds.length; q++) {
      if (T.suitOf(p.melds[q].tid) !== firstSuit) { oneSuit = false; break; }
    }

    var triplets = canAllTriplets(c.slice(), need);
    var dragonSeven = false;
    if (seven) for (var d = 0; d < 27; d++) if (c[d] === 4) dragonSeven = true;
    var goldenHook = (meldCount === 4 && standard);   // 四副副露 + 单钓

    var fans = [];
    var total = 1;                                    // 平胡底番
    fans.push({ name: '平胡', fan: 1 });
    if (seven) { total += 3; fans.push({ name: '七对', fan: 3 }); }
    else {
      if (triplets) { total += 1; fans.push({ name: '对对胡', fan: 1 }); }
      if (goldenHook) { total += 3; fans.push({ name: '金钩钓', fan: 3 }); }
    }
    if (dragonSeven) { total += 1; fans.push({ name: '龙七对', fan: 1 }); }
    if (oneSuit) { total += 3; fans.push({ name: '清一色', fan: 3 }); }
    if (gangCount > 0) { total += gangCount; fans.push({ name: '根 ×' + gangCount, fan: gangCount }); }
    if (ctx.selfDraw) { total += 1; fans.push({ name: '自摸', fan: 1 }); }
    if (ctx.kongFlower) { total += 1; fans.push({ name: '杠上花', fan: 1 }); }
    if (ctx.robKong) { total += 1; fans.push({ name: '抢杠胡', fan: 1 }); }
    if (ctx.lastTile) { total += 1; fans.push({ name: '海底捞月', fan: 1 }); }

    var capped = Math.min(total, g.config.maxFan);
    return {
      win: true, fans: fans, total: total, capped: capped,
      patterns: fans.map(function (f) { return f.name; }),
      hand: T.sortHand(full), oneSuit: oneSuit, seven: seven, goldenHook: goldenHook,
      scoreUnit: Math.pow(2, capped - 1) * g.config.base
    };
  }

  /* 自摸胡（当前回合玩家主动） */
  function selfWin(g, seat) {
    if (g.phase !== 'play' || g.current !== seat) return fail('NOT_YOUR_TURN', '还没轮到你');
    var ctx = {
      selfDraw: true, fromSeat: null, robKong: false,
      kongFlower: !!(g.lastDraw && g.lastDraw.kongFlower && g.lastDraw.seat === seat),
      lastTile: !!(g.lastDraw && g.lastDraw.lastTile && g.lastDraw.seat === seat)
    };
    var w = checkWin(g, seat, null, ctx);
    if (!w.win) return fail('INVALID_ACTION', '这手牌还不能胡');
    settleWin(g, [{ seat: seat, win: w }], ctx);
    return ok();
  }

  /* ---------------- 结算 ---------------- */
  function settleWin(g, results, ctx) {
    var unitList = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i], p = g.players[r.seat], w = r.win;
      var unit = w.scoreUnit;
      var delta = 0;
      if (ctx.selfDraw) {
        // 自摸：三家付（已胡/已退出者不付）
        for (var s = 0; s < 4; s++) {
          if (s === r.seat) continue;
          var other = g.players[s];
          if (other.winner || other.retired) continue;
          other.score -= unit; delta += unit;
        }
      } else {
        // 点炮 / 抢杠胡：点炮者一家付
        var from = ctx.fromSeat;
        if (from == null || from < 0) from = g.lastDiscard ? g.lastDiscard.seat : g.players[0].seat;
        if (g.players[from]) { g.players[from].score -= unit; delta += unit; }
      }
      p.score += delta;
      p.winner = true;
      var rec = {
        seat: r.seat, name: p.name, fan: w.capped, rawFan: w.total,
        names: w.patterns, type: ctx.selfDraw ? '自摸' : (ctx.robKong ? '抢杠胡' : '点炮'),
        tile: ctx.tile == null ? (g.lastDraw ? g.lastDraw.tile : -1) : ctx.tile,
        from: ctx.fromSeat, hand: w.hand, melds: p.melds.slice(), delta: delta, unit: unit
      };
      g.wins.push(rec);
      unitList.push(rec);
      g.seq++;
      emit(g, 'win', { seat: r.seat, names: w.patterns, fan: w.capped, delta: delta, hand: w.hand });
    }
    // 血战到底：胡牌者退出，其余继续
    if (aliveCount(g) <= 1 || !g.wall.length) { endRound(g, 'blood_end'); return; }
    var next = nextAlive(g, ctx.selfDraw ? results[0].seat : (ctx.fromSeat == null ? results[0].seat : ctx.fromSeat));
    if (next < 0) { endRound(g, 'blood_end'); return; }
    g.phase = 'play';
    drawFor(g, next, {});
  }

  /* 听牌 / 查大叫（纯判定） */
  function tingInfo(g, seat) {
    var p = g.players[seat];
    if (!p || p.winner || p.retired || p.lack < 0) return null;
    var c = T.toCounts(p.hand), wins = [];
    for (var id = 0; id < 27; id++) {
      if (T.suitOf(id) === p.lack || c[id] >= 4) continue;
      var w = checkWin(g, seat, id, { selfDraw: false, fromSeat: -1, lastTile: false });
      if (w.win) wins.push({ id: id, fan: w.capped });
    }
    if (!wins.length) return null;
    var max = 1;
    for (var i = 0; i < wins.length; i++) if (wins[i].fan > max) max = wins[i].fan;
    return { tiles: wins, maxFan: max };
  }

  function chaDaJiao(g) {
    var ting = [];
    for (var s = 0; s < 4; s++) {
      var t = tingInfo(g, s);
      g.players[s].ting = t;
      if (t) ting.push(s);
    }
    if (!ting.length || ting.length === aliveCount(g)) return;   // 全听或全不听，互不结算
    for (var i = 0; i < 4; i++) {
      var p = g.players[i];
      if (p.winner || p.retired || p.ting) continue;
      for (var k = 0; k < ting.length; k++) {
        var tp = g.players[ting[k]];
        var unit = Math.pow(2, Math.min(tp.ting.maxFan, g.config.maxFan) - 1) * g.config.base;
        p.score -= unit; tp.score += unit;
        g.wins.push({
          seat: ting[k], name: tp.name, fan: tp.ting.maxFan, names: ['查大叫'],
          type: '查大叫', delta: unit, from: i, hand: [], melds: [], unit: unit
        });
      }
    }
  }

  function endRound(g, reason) {
    if (g.finished) return;
    g.finished = true;
    g.phase = 'settle';
    g.pending = null;
    if (g.config.chaDaJiao && reason === 'wall_empty') chaDaJiao(g);
    // 庄家：胡牌连庄，否则轮转
    var dealerWon = false;
    for (var i = 0; i < g.wins.length; i++)
      if (g.wins[i].seat === g.dealer && g.wins[i].type !== '查大叫') dealerWon = true;
    g.nextDealer = dealerWon ? g.dealer : (g.dealer + 1) % 4;
    g.seq++;
    emit(g, 'settle', { reason: reason, wins: g.wins.slice(), scores: g.players.map(function (p) { return p.score; }) });
  }

  function nextRound(g) {
    g.dealer = g.nextDealer;
    g.round++;
    return startRound(g);
  }

  function availableKongs(g, seat) {
    if (!g.wall.length || g.current !== seat || g.phase !== 'play') return [];
    var p = g.players[seat], c = T.toCounts(p.hand), kongs = [];
    for (var id = 0; id < 27; id++) if (c[id] === 4 && !T.isLack(id,p.lack))
      kongs.push({ tile:id, kind:'concealed' });
    for (var i = 0; i < p.melds.length; i++) {
      var m = p.melds[i];
      if (m.type === 'peng' && c[m.tid] && !T.isLack(m.tid,p.lack))
        kongs.push({ tile:m.tid, kind:'added' });
    }
    return kongs;
  }

  // 练习提示：只用自己手牌、明牌和牌河推导，不读对手暗手或实际牌墙。
  function discardHints(g, seat) {
    var p = g.players[seat];
    if (!p || g.phase !== 'play' || g.current !== seat || p.lack < 0) return [];
    var seen = T.toCounts(p.hand);
    g.river.forEach(function (r) { r.forEach(function (id) { seen[id]++; }); });
    g.players.forEach(function (player) {
      player.melds.forEach(function (m) {
        if (m.type !== 'angang' || player === p) seen[m.tid] += m.n;
      });
    });
    var onlyLack = T.hasLack(p.hand,p.lack), hints = [];
    Array.from(new Set(p.hand)).forEach(function (id) {
      if (onlyLack && !T.isLack(id,p.lack)) return;
      var hand = p.hand.slice(); T.removeOne(hand,id);
      var players = g.players.slice();
      players[seat] = Object.assign({},p,{hand:hand});
      var info = tingInfo(Object.assign({},g,{players:players}),seat);
      if (!info) return;
      var waits = info.tiles.map(function (w) {
        return { id:w.id, fan:w.fan, remaining:Math.max(0,4-seen[w.id]) };
      }).filter(function (w) { return w.remaining > 0; });
      if (waits.length) hints.push({discard:id, waits:waits,
        total:waits.reduce(function (sum,w) { return sum+w.remaining; },0)});
    });
    return hints.sort(function(a,b) { return b.total-a.total || a.discard-b.discard; });
  }

  /* ---------------- 需要行动的座位（供 AI / 托管调度） ---------------- */
  function neededActors(g) {
    var out = [];
    if (g.phase === 'lack') {
      for (var i = 0; i < 4; i++) if (g.players[i].lack < 0 && !g.players[i].retired)
        out.push({ seat: i, kind: 'lack', options: [0, 1, 2] });
    } else if (g.phase === 'play') {
      var s = g.current;
      if (s >= 0 && !g.players[s].winner && !g.players[s].retired) {
        var opts = [];
        var w = checkWin(g, s, null, {
          selfDraw: true,
          kongFlower: !!(g.lastDraw && g.lastDraw.kongFlower && g.lastDraw.seat === s),
          lastTile: !!(g.lastDraw && g.lastDraw.lastTile && g.lastDraw.seat === s)
        });
        opts.push({ type: 'win', ok: w.win });
        var kongs = availableKongs(g, s);
        out.push({ seat: s, kind: 'turn', options: opts, kongs: kongs, hand: g.players[s].hand.slice() });
      }
    } else if (g.phase === 'claim' && g.pending) {
      for (var k in g.pending.opts) if (Object.prototype.hasOwnProperty.call(g.pending.opts, k)) {
        var seat2 = Number(k);
        if (g.pending.responses[seat2] === undefined)
          out.push({ seat: seat2, kind: 'claim', options: g.pending.opts[k].slice().concat(['pass']), tile: g.pending.tile });
      }
    }
    return out;
  }

  /* ---------------- 视图（房主广播 / 客人渲染） ---------------- */
  function getView(g, forSeat) {
    var players = g.players.map(function (p) {
      return {
        seat: p.seat, name: p.name, avatarKey: p.avatarKey, score: p.score, online: p.online, ai: p.ai,
        lack: p.lack, melds: p.melds.map(function (m) {
          return { type: m.type, tid: m.tid, n: m.n, from: m.from };
        }),
        handCount: p.hand.length, discards: g.river[p.seat].length,
        winner: p.winner, retired: p.retired, ting: !!p.ting
      };
    });
    var v = {
      phase: g.phase, round: g.round, dealer: g.dealer, current: g.current,
      wallRemaining: g.wallRemaining, seq: g.seq, hostSeat: g.hostSeat,
      lastDiscard: g.lastDiscard ? { seat: g.lastDiscard.seat, tile: g.lastDiscard.tile, stamp: g.lastDiscard.stamp } : null,
      lastDraw: g.lastDraw ? { seat: g.lastDraw.seat, stamp: g.lastDraw.stamp } : null,
      roundStartScores: g.roundStartScores ? g.roundStartScores.slice() : [0,0,0,0],
      players: players,
      // 精简整数数组（最多 108 个 int，远小于 64KB），不是整局动作日志
      river: g.river.map(function (r) { return r.slice(); }),
      wins: g.wins.map(function (w) { return { seat: w.seat, fan: w.fan, names: w.names, type: w.type, delta: w.delta, hand: w.hand, melds: w.melds, from: w.from }; }),
      config: { maxFan: g.config.maxFan, base: g.config.base, timeout: g.config.timeout, chaDaJiao: g.config.chaDaJiao },
      finished: g.finished
    };
    if (g.pending) v.pending = { from: g.pending.from, tile: g.pending.tile, robKong: g.pending.robKong };
    if (forSeat != null && forSeat >= 0 && forSeat <= 3 && g.players[forSeat]) {
      v.you = forSeat;
      v.hand = T.sortHand(g.players[forSeat].hand);
      v.myOptions = g.pending && g.pending.responses[forSeat] === undefined
        ? (g.pending.opts[forSeat] || []).slice() : [];
      v.myDrawn = g.players[forSeat].drawnTile;
      v.myKongs = availableKongs(g, forSeat);
      if (v.lastDraw && v.lastDraw.seat === forSeat && v.myDrawn != null) v.lastDraw.tile = v.myDrawn;
      v.myWin = checkWin(g, forSeat, null, {
        selfDraw: true,
        kongFlower: !!(g.lastDraw && g.lastDraw.kongFlower && g.lastDraw.seat === forSeat),
        lastTile: !!(g.lastDraw && g.lastDraw.lastTile && g.lastDraw.seat === forSeat)
      }).win;
    }
    return v;
  }

  /* ---------------- 统一动作入口 ---------------- */
  function ok() { return { ok: true, events: null }; }
  function fail(code, msg) { return { ok: false, code: code, msg: msg }; }

  function applyAction(g, msg) {
    msg = msg || {};
    var seat = Number(msg.seat);
    var seq = Number(msg.seq);
    if (!Number.isInteger(seat) || seat < 0 || seat > 3 || !Number.isSafeInteger(seq))
      return fail('INVALID_ACTION','座位或操作序号无效');
    var key = (isNaN(seat) ? -1 : seat) + ':' + (isNaN(seq) ? -1 : seq);
    if (g.seen[key]) return { ok: false, code: 'INVALID_ACTION', msg: '重复的 seq（幂等）', events: [] };
    g.seen[key] = true;
    g.events = [];
    var a = msg.action || {};
    var res;
    switch (a.type) {
      case 'lack': res = setLack(g, seat, Number(a.suit)); break;
      case 'discard': res = discard(g, seat, Number(a.tile)); break;
      case 'claim': res = claim(g, seat, a.choice); break;
      case 'win': res = selfWin(g, seat); break;
      case 'kong':
        res = a.kind === 'added' ? doAddedKong(g, seat, Number(a.tile)) : doConcealedKong(g, seat, Number(a.tile));
        break;
      case 'next':
        if (seat !== g.hostSeat || g.phase !== 'settle') res = fail('INVALID_ACTION','结算后由房主开下一局');
        else { nextRound(g); res = ok(); }
        break;
      case 'leave':
        if (seat < 0 || seat > 3) { res = fail('INVALID_ACTION', '座位无效'); break; }
        g.players[seat].retired = true; g.players[seat].online = false;
        g.seq++; emit(g, 'bye', { seat: seat, reason: 'leave' });
        if (g.phase === 'claim' && g.pending && g.pending.opts[seat]) {
          g.pending.responses[seat] = 'pass';
          var total = Object.keys(g.pending.opts).length;
          if (Object.keys(g.pending.responses).length >= total) resolvePending(g);
        }
        if (aliveCount(g) <= 1) endRound(g, 'blood_end');
        else if (g.phase === 'play' && g.current === seat) drawFor(g,nextAlive(g,seat),{});
        else if (g.phase === 'lack' && g.players.every(function (p) { return p.lack >= 0 || p.retired; })) beginPlay(g);
        res = ok(); break;
      default: res = fail('INVALID_ACTION', '未知动作 ' + a.type);
    }
    var out = {
      ok: res.ok, code: res.code, msg: res.msg,
      events: g.events.slice(), seq: g.seq
    };
    return out;
  }

  /* 客人断线：AI 接管，不阻塞牌局 */
  function setDisconnected(g, seat) {
    if (seat < 0 || seat > 3) return;
    g.players[seat].online = false;
    g.players[seat].ai = true;
  }
  function setReconnected(g, seat, name) {
    if (seat < 0 || seat > 3) return false;
    if (g.players[seat].retired) return false;
    g.players[seat].online = true;
    g.players[seat].ai = false;
    if (name) g.players[seat].name = name;
    return true;
  }

  return {
    createGame: createGame, startRound: startRound, nextRound: nextRound,
    setPlayer: setPlayer, setDisconnected: setDisconnected, setReconnected: setReconnected,
    applyAction: applyAction, getView: getView, neededActors: neededActors,
    checkWin: checkWin, tingInfo: tingInfo, discardHints: discardHints, canStandard: canStandard,
    canAllTriplets: canAllTriplets, canSevenPairs: canSevenPairs,
    setLack: setLack, discard: discard, claim: claim, drawFor: drawFor,
    doAddedKong: doAddedKong, finishRobKong: finishRobKong,
    endRound: endRound, aliveCount: aliveCount, nextAlive: nextAlive,
    emit: emit, SUIT_CN: SUIT_CN
  };
});
