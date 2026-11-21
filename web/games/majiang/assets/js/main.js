/* main.js — 启动参数解析、主循环、事件绑定、AI/托管调度和牌桌状态 */
(function () {
  'use strict';
  var T = window.MJ.Tiles, E = window.MJ.Engine, AI = window.MJ.AI,
      Audio = window.MJ.Audio, Net = window.MJ.Net, UI = window.MJ.UI;

  var AI_NAMES = ['小雀', '阿筒', '老万'];
  var AI_AVATARS = ['rabbit','robot','panda'];
  var ERR_CN = {
    NOT_YOUR_TURN: '还没轮到你', INVALID_ACTION: '操作无效', ROOM_FULL: '房间已满',
    ROOM_NOT_FOUND: '房间不存在', NOT_HOST: '只有房主能推进局面'
  };

  var st = {
    room: 'DEMO', mySeat: 0, name: '我', avatarKey: 'fox', host: '', port: 8765, isHost: true,
    mode: 'local',                     // host | guest | local
    game: null, net: null, view: null,
    selectedIndex: -1, selectedTile: -1,
    roundStartScores: [0, 0, 0, 0],
    localSeq: 900000000, humanIdle: {}, guestIdle: null, pacer: AI.createPacer(),
    audioUnlocked: false
  };

  function parseParams() {
    var q = new URLSearchParams(window.location.search || '');
    var raw = {
      room: q.get('room'), seat: q.get('seat'), name: q.get('name'), avatarKey:normalizeAvatar(q.get('avatar')),
      host: q.get('host'), port: q.get('port'), isHost: q.get('isHost') === '1' && q.get('seat') === '0', practice: q.get('mode') === 'practice', token: q.get('token')
    };
    raw.empty = !window.location.search || window.location.search === '?';
    return raw;
  }

  function ctx() {
    return {
      mySeat: st.mySeat, room: st.room, isHost: st.isHost,
      authority: st.mode !== 'guest', mode: st.mode,
      scale: UI.getScale(), selectedIndex: st.selectedIndex,
      roundStartScores: st.roundStartScores,
      onAction: onAction, onTileClick: onTileClick
    };
  }

  function currentView() {
    if (st.mode === 'guest') return st.view;
    return st.game ? E.getView(st.game, st.mySeat) : null;
  }

  function render() {
    var v = currentView();
    if (!v) return;
    document.documentElement.dataset.gamePhase = v.phase;
    document.documentElement.dataset.gameMode = st.mode;
    if (v.roundStartScores) st.roundStartScores = v.roundStartScores;
    UI.render(v, ctx());
    renderWait();
    UI.setTools(Audio.state());
  }

  /* ---------------- 动效与音效 ---------------- */
  function sounds(events) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'deal' || e.type === 'lack') Audio.play(e.type === 'deal' ? 'deal' : 'lack');
      else if (e.type === 'discard') Audio.play('discard');
      else if (e.type === 'draw') Audio.play('draw');
      else if (e.type === 'peng') Audio.play('peng');
      else if (e.type === 'gang' || e.type === 'kongTry') Audio.play('gang');
      else if (e.type === 'win') Audio.play('win');
      else if (e.type === 'settle') Audio.play('settle');
    }
  }
  function diffEvents(a, b) {
    var ev = [];
    if ((!a || a.phase === 'init' || b.round !== a.round) && b.phase !== 'init') ev.push({ type:'deal' });
    if (!a) {
      if (b.phase === 'settle') ev.push({type:'settle'});
      return ev;
    }
    var ld = b.lastDiscard, pd = a.lastDiscard;
    if (ld && (!pd || (ld.stamp ? ld.stamp !== pd.stamp : ld.seat !== pd.seat || ld.tile !== pd.tile)))
      ev.push({ type:'discard', seat:ld.seat, tile:ld.tile });
    var dr = b.lastDraw, pr = a.lastDraw;
    if (dr && (!pr || (dr.stamp ? dr.stamp !== pr.stamp : dr.seat !== pr.seat || dr.tile !== pr.tile)) &&
        b.phase === 'play' && b.wallRemaining < a.wallRemaining) ev.push({type:'draw',seat:dr.seat});
    if (a.round === b.round) {
      (b.players || []).forEach(function (p,i) {
        var old = a.players && a.players[i];
        if (!old) return;
        (p.melds || []).forEach(function (meld,j) {
          var prev = (old.melds || [])[j];
          if (!prev || prev.type !== meld.type) ev.push({type:meld.type === 'peng' ? 'peng' : 'gang',seat:i});
        });
      });
      (b.wins || []).slice((a.wins || []).length).forEach(function (w) {
        if (w.type !== '查大叫') ev.push({type:'win', seat:w.seat, fan:w.fan});
      });
    }
    if (b.phase === 'settle' && a.phase !== 'settle') ev.push({type:'settle'});
    return ev;
  }

  /* 房主/本地：一次权威动作之后的统一后处理 */
  function afterApply(res) {
    st.selectedIndex = -1; st.selectedTile = -1;
    var events = res.events || [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].type === 'deal') {
        st.roundStartScores = st.game.players.map(function (p) { return p.score; });
      }
    }
    render();
    var v = currentView();
    UI.playEvents(events, v, ctx());
    sounds(events);
  }

  function localApply(action, seat) {
    if (!st.game) return { ok: false };
    var res = E.applyAction(st.game, { t: 'action', seq: ++st.localSeq, seat: seat, action: action });
    if (!res.ok) { UI.toast(res.msg || ERR_CN[res.code] || '操作无效', true); return res; }
    afterApply(res);
    if (st.net && st.net.isHost) st.net.broadcastState();
    return res;
  }

  /* 客人：只发 action；房主/本地：本地推进 */
  function doAction(action) {
    if (st.mode === 'guest' && st.net && !st.net._detached) {
      st.net.sendAction(action);
    } else {
      localApply(action, st.mySeat);
    }
  }

  /* ---------------- 交互回调 ---------------- */
  function canDiscard() {
    var v = currentView();
    return v && v.phase === 'play' && v.current === st.mySeat;
  }
  function onTileClick(idx, tileId) {
    if (!canDiscard()) return;
    var v = currentView(), me = v.players[st.mySeat];
    if (T.hasLack(v.hand,me.lack) && !T.isLack(tileId,me.lack)) {
      UI.toast('请先打完缺门牌',true); return;
    }
    if (st.selectedIndex === idx && canDiscard()) {
      doAction({ type: 'discard', tile: tileId });
      return;
    }
    st.selectedIndex = (st.selectedIndex === idx) ? -1 : idx;
    st.selectedTile = (st.selectedIndex < 0) ? -1 : tileId;
    render();
  }

  function onAction(act, val) {
    unlockAudio();
    switch (act) {
      case 'closeModal': UI.closeModal(); return;
      case 'noop': return;
      case 'lack': doAction({ type: 'lack', suit: Number(val) }); break;
      case 'discard': if (st.selectedTile >= 0 && canDiscard()) doAction({ type: 'discard', tile: st.selectedTile }); break;
      case 'win': doAction({ type: 'win' }); break;
      case 'kong': {
        var p = String(val).split(':');
        doAction({ type: 'kong', tile: Number(p[0]), kind: p[1] });
        break;
      }
      case 'claim': doAction({ type: 'claim', choice: String(val) }); break;
      case 'next': UI.closeModal(); doAction({ type: 'next' }); break;
      case 'settlement': UI.showSettle(currentView(), ctx()); return;
      case 'hint': showHint(); return;
      case 'selectHint': {
        var id = Number(val), hand = UI.displayHand(currentView(),st.mySeat);
        var index = hand.lastIndexOf(id);
        if (index >= 0 && canDiscard()) { st.selectedTile = id; st.selectedIndex = index; }
        UI.closeModal(); render(); return;
      }
      case 'localDemo': startLocalDemo(); return;
      case 'back': goBack(); return;
      case 'leave': confirmLeave(); return;
      case 'leaveYes':
        if (st.net) st.net.close();
        st.game = null; st.view = null;
        UI.closeModal();
        if (window.parent !== window) window.parent.postMessage({type:'jinchuan-mahjong-close'},window.location.origin);
        else window.location.assign('./index.html');
        return;
      case 'mute': toggleMute(); showSettings(); break;
      case 'bgm': toggleBgm(); showSettings(); break;
      case 'setFan': {
        var f = Number(val);
        if (st.game && st.game.phase === 'settle' && [4,6,8,10].indexOf(f) >= 0) {
          st.game.config.maxFan = f;
          if (st.net) st.net.broadcastState();
          render();
        }
        showSettings(); break;
      }
      case 'help': showHelp(); return;
      case 'settings': showSettings(); return;
      default: break;
    }
  }

  function unlockAudio() {
    if (st.audioUnlocked) return;
    st.audioUnlocked = true;
    Audio.unlock();
  }
  function toggleMute() {
    unlockAudio();
    Audio.setMuted(!Audio.state().muted);
    UI.setTools(Audio.state());
  }
  function toggleBgm() {
    unlockAudio();
    Audio.setBgm(!Audio.state().bgmOn);
    UI.setTools(Audio.state());
  }
  function goBack() {
    if (st.net) st.net.close();
    if (window.parent !== window) window.parent.postMessage({type:'jinchuan-mahjong-close'},window.location.origin);
    else window.location.assign('./index.html');
  }
  function confirmLeave() {
    var note = st.mode === 'host' ? '房主离开后，这张桌会关闭。' :
      st.mode === 'guest' ? '离开后，这个座位由电脑接手。' : '本局练习进度不会保留。';
    UI.modal('<h2>退出本桌</h2><div class="lead">' + note + '</div>' +
      '<div class="row"><button class="act-btn red" data-act="leaveYes">确认退出</button>' +
      '<button class="act-btn ghost" data-act="closeModal">继续游戏</button></div>');
  }

  function showHint() {
    if (st.mode !== 'local' || !canDiscard()) return;
    var hints = E.discardHints(st.game,st.mySeat);
    var h = '<h2>听牌提示</h2><p class="lead">只根据自己的手牌和已公开的牌估算，不代表牌墙里的实际张数。</p>';
    if (!hints.length) h += '<p class="hint-empty">当前没有打出一张即可听牌的选择。</p>';
    else h += '<div class="advice-list">' + hints.map(function(r){
      return '<button type="button" class="advice-row" data-act="selectHint" data-val="' + r.discard + '">' +
        '<strong>打 ' + T.tileName(r.discard) + '</strong><span>听 ' + r.waits.map(function(w){
          return T.tileName(w.id) + ' × ' + w.remaining;
        }).join('、') + '</span><em>最多 ' + r.total + ' 张</em></button>';
    }).join('') + '</div>';
    h += '<div class="row"><button class="act-btn ghost" data-act="closeModal">关闭</button></div>';
    UI.modal(h,{closable:true});
  }
  function showHelp() {
    UI.modal('<h2>四川麻将 · 血战到底</h2><div class="lead">单人练习 · 好友联机</div>' +
      '<h3>基本规则</h3><ul>' +
      '<li>108 张：万 / 条 / 筒 1–9 各 4 张，无字牌无花牌。</li>' +
      '<li><b>定缺</b>：开局必选一门，手里不能留该门牌，未打完不能胡；有缺门牌时必须先打缺门。</li>' +
      '<li><b>碰 / 明杠 / 暗杠 / 补杠</b>；补杠可被<b>抢杠胡</b>。</li>' +
      '<li><b>血战到底</b>：胡牌者退出本局，其余继续，直到剩 1 人或牌墙摸完。</li>' +
      '<li><b>一炮多响</b>：一张牌可多家同时胡，按座位顺序结算。</li>' +
      '<li>庄家胡牌连庄，否则轮转；流局<b>已支持查大叫</b>（未听牌者按听牌者最大番赔付）。</li>' +
      '<li>好友联机每次决策限时 15 秒；单人练习没有倒计时，可查看定缺建议和听牌提示。</li></ul>' +
      '<h3>番型（封顶可在设置里调整）</h3><p>平胡、对对胡、清一色、七对 / 龙七对、金钩钓、根（杠）、自摸、杠上花、抢杠胡、海底捞月。' +
      '自摸三家付、点炮一家付，倍数按 2^(番-1) 计算并封顶。</p>' +
      '<h3>联机</h3><p>四人到齐由房主开局。客人离线后由电脑代打；房主离开后牌桌关闭。</p>' +
      '<div class="row"><button class="act-btn gold" data-act="closeModal">知道了</button></div>');
  }
  function showSettings() {
    var fan = ((currentView() || {}).config || {}).maxFan || 8;
    var a = Audio.state();
    var h = '<h2>设置</h2><div class="lead">所有设置仅保存在内存中，刷新后恢复默认</div>';
    h += '<h3>封顶番数</h3><p class="lead">结算后可由房主或练习玩家调整，下一局生效。</p><div class="row">';
    [4, 6, 8, 10].forEach(function (f) {
      h += '<button class="act-btn ' + (f === fan ? 'gold' : 'ghost') + '" data-act="setFan" data-val="' + f + '"' + (st.game && st.game.phase === 'settle' ? '' : ' disabled') + '>' + f + ' 番</button>';
    });
    h += '</div>';
    h += '<h3>音频</h3><div class="row">' +
      '<button class="act-btn ' + (a.muted ? 'ghost' : 'gold') + '" data-act="mute">音效 ' + (a.muted ? '关' : '开') + '</button>' +
      '<button class="act-btn ' + (a.bgmOn ? 'gold' : 'ghost') + '" data-act="bgm">背景音乐 ' + (a.bgmOn ? '开' : '关') + '</button></div>';
    h += '<p style="margin-top:14px">音效由 Web Audio 实时合成，无音频文件、无网络请求；首次点击页面后才会启用（浏览器自动播放策略）。</p>';
    h += '<div class="row"><button class="act-btn ghost" data-act="closeModal">关闭</button></div>';
    UI.modal(h);
  }

  /* ---------------- 联机回调 ---------------- */
  function onState(view, priv) {
    if (st.mode !== 'guest') return;
    var prev = st.view;
    if (prev && view.seq < prev.seq) return;
    var v = Object.assign({}, view);
    v.you = st.mySeat;
    v.hand = priv && priv.hand || [];
    v.myOptions = priv && priv.myOptions || [];
    v.myKongs = priv && priv.myKongs || [];
    v.myWin = !!(priv && priv.myWin);
    if (priv && priv.myDrawn != null && v.lastDraw && v.lastDraw.seat === st.mySeat) {
      v.lastDraw = Object.assign({},v.lastDraw,{tile:priv.myDrawn});
    }
    if (!prev || prev.phase !== v.phase || prev.current !== v.current || prev.hand.join(',') !== v.hand.join(',')) {
      st.selectedIndex = -1; st.selectedTile = -1;
    }
    st.view = v;
    UI.hideBoot();
    render();
    var ev = diffEvents(prev, v);
    UI.playEvents(ev, v, ctx());
    sounds(ev);
  }
  function onError(code, msg) {
    if (st.mode === 'local') return;
    var detail = {
      ROOM_FULL: ['牌桌已满','四个座位都有人，请等下一桌。'],
      ROOM_NOT_FOUND: ['牌桌已关闭','这条邀请已经失效，请让房主重新开桌。'],
      SEAT_TAKEN: ['座位已被占用','请从聊天里的邀请重新加入。'],
      NETWORK_UNAVAILABLE: ['未连上牌桌','确认双方在同一个局域网，并使用新版近传。']
    }[code];
    if (!detail) { UI.toast(ERR_CN[code] || msg || '操作被拒绝',true); return; }
    UI.closeModal();
    UI.boot('<div class="boot-card"><h2>' + detail[0] + '</h2><p>' + detail[1] + '</p>' +
      '<div class="row"><button class="act-btn gold" data-act="back">返回</button></div></div>');
  }
  function onBye(reason, seat) {
    if (st.mode === 'local') return;
    if (reason === 'host_left') {
      if (st.net) st.net.detach();
      st.view = null; renderWait();
      UI.boot('<div class="boot-card"><h2>房主已离开</h2>' +
        '<p>本桌已解散，你可以返回大厅，或先开一局单机试玩。</p>' +
        '<div class="row"><button class="act-btn gold" data-act="back">返回大厅</button>' +
        '<button class="act-btn ghost" data-act="localDemo">单机试玩</button></div>' +
        '<p class="boot-sub">离线可玩 · 不请求任何外网资源</p></div>');
    } else {
      UI.toast('有玩家离开，该席位由 AI 接管，血战继续');
      if (st.game && seat >= 0 && seat <= 3) {
        E.setDisconnected(st.game,seat);
        if (st.net) st.net.broadcastState();
      }
      render();
    }
  }
  function onStatus(text, kind) {
    if (st.mode === 'local') return;
    if (kind === 'waiting') {
      renderWait();
      var title = st.mode === 'host' ? '正在开桌…' : (st.view ? '正在重连牌桌…' : '正在加入牌桌…');
      UI.boot('<div class="boot-card"><div class="spinner"></div><h2>' + title + '</h2>' +
        '<div class="row"><button class="act-btn ghost" data-act="back">返回</button></div></div>');
    } else if (kind === 'online' && st.mode === 'host') {
      UI.hideBoot(); renderWait();
      if (window.parent !== window)
        window.parent.postMessage({type:'jinchuan-mahjong-ready',room:st.room},location.origin);
    }
  }

  /* ---------------- 对局、托管与等候室 ---------------- */
  function newLocalGame(practice) {
    var g = E.createGame({ room: st.room, hostSeat: st.mySeat });
    E.setPlayer(g, st.mySeat, { name: st.name, avatarKey:st.avatarKey, online:true, ai:false });
    var bot = 0;
    for (var seat = 0; seat < 4; seat++) if (seat !== st.mySeat)
      E.setPlayer(g, seat, { name:practice ? AI_NAMES[bot] : '等待玩家',
        avatarKey:practice ? AI_AVATARS[bot++] : 'fox', online:practice, ai:practice });
    return g;
  }
  function beginRound() {
    E.startRound(st.game);
    afterApply({events:st.game.events.slice()});
    if (st.net) st.net.broadcastState();
  }
  function startLocalDemo(name,avatarKey) {
    st.mode = 'local'; st.isHost = true;
    if (st.net) st.net.close();
    st.net = null;
    st.mySeat = 0; st.room = '练习'; st.name = name || st.name;
    if (avatarKey) st.avatarKey = normalizeAvatar(avatarKey);
    st.game = newLocalGame(true); st.view = null;
    st.humanIdle = {}; st.guestIdle = null; st.pacer = AI.createPacer();
    UI.hideTimer(); UI.hideBoot(); UI.closeModal(); beginRound();
  }
  function decisionKey(v, seat) {
    if (!v) return '';
    var p = v.players && v.players[seat];
    if (!p || p.winner || p.retired) return '';
    var prefix = v.round + ':';
    if (v.phase === 'lack' && p.lack < 0) return prefix + 'lack';
    if (v.phase === 'claim' && v.myOptions && v.myOptions.length)
      return prefix + 'claim:' + (v.lastDiscard && v.lastDiscard.stamp || '') + ':' + v.pending.from + ':' + v.pending.tile;
    if (v.phase === 'play' && v.current === seat)
      return prefix + 'turn:' + (v.lastDraw && v.lastDraw.stamp || '') + ':' + (v.lastDiscard && v.lastDiscard.stamp || '') + ':' + p.melds.length;
    return '';
  }
  function tick() {
    var now = performance.now();
    if (st.mode === 'guest') {
      var v = st.view, key = decisionKey(v,st.mySeat);
      if (!key) { UI.hideTimer(); st.guestIdle = null; return; }
      if (!st.guestIdle || st.guestIdle.key !== key) st.guestIdle = {key:key,since:now};
      var cap = (v.config || {}).timeout || 15;
      UI.setTimer(Math.max(0,cap-(now-st.guestIdle.since)/1000),cap);
      return;
    }
    if (!st.game) return;
    var g = st.game, actors = E.neededActors(g);
    var actor = actors.find(function(candidate){return g.players[candidate.seat].ai;});
    var key = actor ? [g.round,g.seq,actor.seat,actor.kind].join(':') : '';
    if (st.pacer.ready(key, actor && actor.kind, now)) {
      var auto = AI.autoAction(g,actor);
      if (auto) localApply(auto,actor.seat);
      return;
    }
    if (st.mode === 'local') { UI.hideTimer(); return; }
    var need = {};
    UI.hideTimer();
    for (var j = 0; j < actors.length; j++) {
      var a = actors[j];
      if (g.players[a.seat].ai) continue;
      var decision = decisionKey(E.getView(g,a.seat),a.seat);
      if (!decision) continue;
      var clock = st.humanIdle[a.seat];
      if (!clock || clock.key !== decision) clock = {key:decision,since:now};
      need[a.seat] = clock;
      var left = g.config.timeout - (now-clock.since)/1000;
      if (a.seat === st.mySeat) UI.setTimer(Math.max(0,left),g.config.timeout);
      if (left <= 0) {
        delete need[a.seat];
        st.humanIdle = need;
        var move = AI.autoAction(g,a);
        if (move) localApply(move,a.seat);
        if (a.seat === st.mySeat) UI.toast('本次操作已由电脑代打');
        return;
      }
    }
    st.humanIdle = need;
  }

  var waitEl = null, waitMarkup = '';
  function renderWait() {
    var game = currentView();
    if (!game || game.phase !== 'init' || st.mode === 'local' || st.net?.mode !== 'online') {
      if (waitEl) { waitEl.remove(); waitEl = null; waitMarkup = ''; }
      return;
    }
    if (!waitEl) {
      waitEl = document.createElement('div');
      waitEl.id = 'mj-wait';
      waitEl.innerHTML = '<section class="mjw-card" aria-labelledby="mjw-title"><div class="mjw-kicker">好友联机</div>' +
        '<h2 class="mjw-title" id="mjw-title">等待玩家</h2><div class="mjw-seats"></div>' +
        '<div class="mjw-tip"></div><button class="mjw-btn" type="button">开始游戏</button></section>';
      document.body.appendChild(waitEl);
      waitEl.querySelector('.mjw-btn').addEventListener('click',function(){
        if (st.mode === 'host' && st.game.phase === 'init' && st.game.players.every(function(p){return p.online;})) beginRound();
      });
    }
    var n = game.players.filter(function(p){return p.online;}).length;
    var html = game.players.map(function(p){
      return '<span class="' + (p.online?'on':'off') + '">' +
        (p.online ? avatarImage(p.avatarKey) : '<i aria-hidden="true"></i>') +
        '<b title="' + UI.esc(p.online?p.name:'空位') + '">' + UI.esc(p.online?p.name:'空位') + '</b></span>';
    }).join('');
    if (waitMarkup === html) return;
    waitMarkup = html;
    waitEl.querySelector('.mjw-seats').innerHTML = html;
    waitEl.querySelector('.mjw-title').textContent = '等待玩家 ' + n + '/4';
    waitEl.querySelector('.mjw-tip').textContent = n < 4 ? '四人到齐后，由房主开局。' : (st.mode === 'host' ? '所有玩家已入座。' : '等待房主开始。');
    var btn = waitEl.querySelector('.mjw-btn');
    btn.hidden = st.mode !== 'host'; btn.disabled = n < 4;
  }

  function bootError(p, missing) {
    UI.boot('<div class="boot-card"><h2>启动参数不完整</h2>' +
      '<p>缺少：' + UI.esc(missing.join(' / ')) + '。游戏页需要由客户端注入启动参数，不能静默启动。</p>' +
      '<p>正确示例：<br><code>/games/majiang/index.html?room=RID&amp;seat=2&amp;name=张三&amp;host=192.168.1.8&amp;port=8765&amp;isHost=0</code></p>' +
      '<p>也可以直接单机试玩（3 家 AI 补位，无需任何参数）。</p>' +
      '<div class="row"><button class="act-btn gold" data-act="localDemo">单机试玩</button></div>' +
      '<p class="boot-sub">四川麻将 · 血战到底 1.0.0 · 离线运行</p></div>');
  }

  function start(p) {
    st.room = p.room; st.mySeat = p.seat === 'auto' ? null : Number(p.seat); st.name = p.name; st.avatarKey = p.avatarKey;
    st.host = p.host || ''; st.port = Number(p.port) || 8765;
    st.isHost = p.isHost;
    st.mode = st.isHost ? 'host' : 'guest';

    if (st.mode === 'host') {
      st.game = newLocalGame(false);
      st.roundStartScores = [0, 0, 0, 0];
    }
    st.net = Net.create({
      room: st.room, seat: p.seat, name: st.name, avatarKey:st.avatarKey,
      host: st.host, port: st.port, isHost: st.isHost, game: st.game,
      onSeated: function (seat) { st.mySeat = seat; },
      onState: onState, onError: onError, onBye: onBye, onStatus: onStatus,
      onJoin: function (seat, name) {
        UI.toast(name + ' 已落座（席位 ' + seat + '）');
        if (st.game) E.setPlayer(st.game, seat, { online: true, ai: false, name: name });
        render();
      },
      onProfile: render,
      onHostApplied: function (res) { afterApply(res); },
      onRoomFull: function () {}
    });
    onStatus('', 'waiting');
    st.net.connect();
    if (st.mode === 'host') render();
  }

  // 父窗口可在桌面资料变化时复用同一头像。只接收本页父窗口的同源事件。
  window.addEventListener('message',function(e){
    if (window.parent === window || e.source !== window.parent || e.origin !== location.origin ||
        !e.data || e.data.type !== 'jinchuan-mahjong-profile') return;
    var name = typeof e.data.name === 'string' ? e.data.name.trim().slice(0,24) : '';
    if (!name) return;
    var avatar = normalizeAvatar(e.data.avatarKey);
    if (st.name === name && st.avatarKey === avatar) return;
    st.name = name; st.avatarKey = avatar;
    if (st.game) E.setPlayer(st.game, st.mySeat, {name:name,avatarKey:avatar});
    if (st.net) st.net.updateProfile(name,avatar);
    render();
  });

  function main() {
    UI.init();
    UI.setContext(ctx());
    window.setInterval(tick, 90);   // 全局唯一主循环，裸开试玩也能驱动 AI
    document.addEventListener('pointerdown', unlockAudio, { once: true });
    document.addEventListener('keydown', unlockAudio, { once: true });
    document.getElementById('btn-mute').addEventListener('click', toggleMute);
    document.getElementById('btn-bgm').addEventListener('click', toggleBgm);
    document.getElementById('btn-help').addEventListener('click', showHelp);
    document.getElementById('btn-settings').addEventListener('click', showSettings);
    document.getElementById('btn-leave').addEventListener('click', confirmLeave);
    window.addEventListener('resize', function () { UI.setScale(); if (currentView()) render(); });
    window.onerror = function (msg) {
      UI.toast('页面异常：' + String(msg).slice(0, 70), true);
      return false;
    };

    var p = parseParams();
    if (p.practice || p.empty) {
      startLocalDemo(p.name || '我',p.avatarKey);
      window.__MJ_BOOTED__ = true;
      return;
    }
    var missing = [];
    if (!p.room) missing.push('room');
    if (p.seat == null || p.seat === '') missing.push('seat');
    if (!p.name) missing.push('name');
    var seatNum = Number(p.seat);
    if (p.seat && p.seat !== 'auto' && !(Number.isInteger(seatNum) && (p.isHost ? seatNum === 0 : seatNum >= 1 && seatNum <= 3))) missing.push('座位');

    if (missing.length) {
      // 完全裸开也给可读引导页 + 试玩入口，不白屏、不静默失败
      st.room = 'DEMO'; st.mySeat = 0; st.name = '我';
      bootError(p, missing);
    } else {
      start(p);
    }
    window.__MJ_BOOTED__ = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})();
