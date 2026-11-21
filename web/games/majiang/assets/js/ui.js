/* ui.js — 渲染与动效。纯 DOM + 内联 SVG，不依赖 canvas，天然适配 devicePixelRatio。
   视角旋转：自己恒在下方（pos = (seat - mySeat + 4) % 4）。
   动效只用 transform/opacity，动画层独立，不阻塞操作。 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.MJ = root.MJ || {};
  root.MJ.UI = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function motionAllowed() {
    return document.documentElement.dataset.motion !== 'reduced' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  var T = (typeof module !== 'undefined' && module.exports)
    ? require('./tiles.js')
    : ((typeof window !== 'undefined' ? window : globalThis).MJ.Tiles);
  var E = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : ((typeof window !== 'undefined' ? window : globalThis).MJ.Engine);

  var stage, fx, modalLayer, toastLayer, bootLayer, actionbar, riverSides = [], slots = [];
  var btnMute, btnBgm, timerEl, timerNum, current = null, scale = 1, modalOpts = null;
  var POS = ['bottom', 'right', 'top', 'left'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }

  function init() {
    stage = el('stage'); fx = el('fx-layer'); modalLayer = el('modal-layer');
    toastLayer = el('toast-layer'); bootLayer = el('boot-layer');
    actionbar = el('actionbar'); btnMute = el('btn-mute'); btnBgm = el('btn-bgm');
    timerEl = el('turn-timer'); timerNum = el('timer-num');
    for (var i = 0; i < 4; i++) {
      riverSides.push(document.querySelector('.river-side[data-pos="' + i + '"]'));
      slots.push(document.querySelector('.slot-' + POS[i]));
    }
    // 事件委托：整个舞台只绑一次，避免反复增删监听导致内存增长
    stage.addEventListener('click', function (ev) {
      var c = current;
      if (!c) return;
      var tile = ev.target.closest ? ev.target.closest('.tile.mine') : null;
      if (tile && c.onTileClick) {
        var idx = Number(tile.getAttribute('data-idx'));
        var tid = Number(tile.getAttribute('data-tile'));
        c.onTileClick(idx, tid);
        return;
      }
      var btn = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (btn && !btn.disabled && c.onAction) {
        c.onAction(btn.getAttribute('data-act'), btn.getAttribute('data-val'), btn);
      }
    });
    window.addEventListener('resize', setScale);
    setScale();
  }

  function setScale() {
    var k = Math.min(window.innerWidth / 1280, window.innerHeight / 760);
    if (stage) stage.style.transform = 'scale(' + k + ')';
    scale = k;
    return k;
  }
  function getScale() { return scale; }

  /* 逻辑坐标（fx 层在 scale 之后的 stage 内部，需把屏幕坐标除以缩放比） */
  function box(node) {
    var r = node.getBoundingClientRect(), s = stage.getBoundingClientRect();
    return {
      x: (r.left - s.left) / scale, y: (r.top - s.top) / scale,
      w: r.width / scale, h: r.height / scale
    };
  }
  function center(node) {
    var b = box(node);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h };
  }

  function setContext(ctx) { current = ctx; }

  function setTools(st) {
    if (!btnMute) return;
    btnMute.textContent = st.muted ? '音效 关' : '音效 开';
    btnMute.classList.toggle('on', !st.muted);
    btnBgm.textContent = st.bgmOn ? '音乐 开' : '音乐 关';
    btnBgm.classList.toggle('on', st.bgmOn);
  }
  function setTimer(secs,total) {
    if (!timerEl) return;
    timerEl.classList.remove('hidden');
    var value = String(Math.max(0,Math.ceil(secs)));
    if (timerNum.textContent !== value) timerNum.textContent = value;
    timerEl.style.setProperty('--clock', Math.max(0,Math.min(1,secs/(total||15)))*100 + '%');
    timerEl.classList.toggle('urgent', secs <= 5);
  }
  function hideTimer() { if (timerEl) timerEl.classList.add('hidden'); }

  function toast(msg, isErr) {
    if (!toastLayer) return;
    while (toastLayer.children.length >= 2) toastLayer.firstElementChild.remove();
    var d = document.createElement('div');
    d.className = 'toast' + (isErr ? ' err' : '');
    d.textContent = msg;
    toastLayer.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2400);
    while (toastLayer.children.length > 4) toastLayer.removeChild(toastLayer.firstChild);
  }
  function boot(html) {
    if (!bootLayer) return;
    bootLayer.innerHTML = html;
    bootLayer.style.display = 'flex';
  }
  function hideBoot() { if (bootLayer) bootLayer.style.display = 'none'; }

  function modal(html, opts) {
    if (!modalLayer) return;
    modalOpts = opts || {};
    modalLayer.innerHTML = '<div class="mask"><div class="modal">' + html + '</div></div>';
    var mask = modalLayer.querySelector('.mask');
    if (modalOpts.closable !== false) {
      mask.addEventListener('click', function (e) {
        if (e.target === mask) closeModal();
      });
    }
  }
  function closeModal() {
    if (modalLayer) modalLayer.innerHTML = '';
    var o = modalOpts; modalOpts = null;
    if (o && o.onClose) o.onClose();
  }

  function displayHand(view,seat) {
    var hand = (view.hand || []).slice(), draw = view.lastDraw;
    if (view.phase === 'play' && view.current === seat && draw && draw.seat === seat && draw.tile != null) {
      var index = hand.lastIndexOf(draw.tile);
      if (index >= 0) hand.push(hand.splice(index,1)[0]);
    }
    return hand;
  }
  function setMarkup(node,html) {
    if (node._lastHTML === html) return false;
    node._lastHTML = html;
    node.innerHTML = html;
    return true;
  }
  /* ---------------- 主渲染 ---------------- */
  function render(view, ctx) {
    current = ctx;
    if (!view || !view.players) return;
    scale = scale || 1;
    var you = ctx.mySeat;
    var phaseCN = { lack: '定缺', play: '对局中', claim: '响应中', settle: '已结算', init: '准备中', over: '结束' }[view.phase] || view.phase;

    el('room-id').textContent = ctx.mode === 'local' ? '单人练习' : (ctx.room || '----');
    el('table-kind').textContent = ctx.mode === 'local' ? '模式' : '房间';
    el('round-label').textContent = '第 ' + (view.round || 1) + ' 局';
    el('phase-label').textContent = phaseCN;
    var online = 0;
    for (var q = 0; q < 4; q++) if (view.players[q] && view.players[q].online) online++;
    el('seat-count').textContent = ctx.mode === 'local' ? '3 家电脑' : online + '/4';
    el('wall-num').textContent = view.wallRemaining == null ? 0 : view.wallRemaining;

    // 四家座位
    for (var s = 0; s < 4; s++) {
      var p = view.players[s] || {};
      var pos = (s - you + 4) % 4;
      var slot = slots[pos];
      if (!slot) continue;
      var isMe = (s === you);
      var active = (view.phase === 'play' && view.current === s);
      var cls = 'info-card' + (active ? ' active' : '') + (!p.online ? ' offline' : '') + (p.winner ? ' winner' : '');
      var tag = (s === view.hostSeat) ? '<span class="tag">房主</span>' : '';
      if (p.ai) tag += '<span class="tag ai">AI</span>';
      if (p.winner) tag += '<span class="tag">已胡</span>';
      var nick = esc(p.name || ('玩家' + (s + 1)));
      var score = p.score || 0;
      var lackTxt = p.lack >= 0 ? ('缺' + E.SUIT_CN[p.lack]) : '未定缺';
      var card = '<div class="' + cls + '">' +
        '<div class="avatar' + (p.ai ? ' ai' : '') + '">' + avatarImage(p.avatarKey) + '</div>' +
        '<div class="info-main"><div class="nick">' + nick + tag + '</div>' +
        '<div class="sub"><span class="score' + (score < 0 ? ' neg' : '') + '">' + (score > 0 ? '+' : '') + score + '</span>' +
        '<span class="sep">·</span><span class="lack">' + lackTxt + '</span>' +
        '<span class="sep">·</span>' + (p.handCount == null ? 0 : p.handCount) + '张</div></div>' +
        '<div class="online-dot"></div></div>';

      var melds = '<div class="melds">' + (p.melds || []).map(function (m) {
        return T.meldHTML(m.tid, m.n, m.type);
      }).join('') + '</div>';

      var hand = '';
      if (isMe) {
        var h = displayHand(view,you), draw = view.lastDraw;
        var myTurn = view.phase === 'play' && view.current === you;
        var onlyLack = myTurn && T.hasLack(h,p.lack);
        var drawnPos = myTurn && draw && draw.seat === you && draw.tile != null ? h.lastIndexOf(draw.tile) : -1;
        for (var i = 0; i < h.length; i++) {
          var lack = T.isLack(h[i],p.lack), selected = ctx.selectedIndex === i;
          var t = T.tileHTML(h[i], {mine:true,lack:lack,selected:selected,drawn:i===drawnPos,dim:onlyLack&&!lack});
          hand += t.replace('<div class="tile','<button type="button" data-idx="' + i + '"' +
            ' aria-label="' + T.tileName(h[i]) + '" aria-pressed="' + selected + '"' +
            ((!myTurn || (onlyLack && !lack)) ? ' disabled' : '') + ' class="tile').slice(0,-6) + '</button>';
        }
        hand = '<div class="hand mine">' + hand + '</div>';
      } else {
        var n = Math.min(p.handCount || 0, 14);
        var back = '';
        var size = (pos === 1 || pos === 3) ? 'slim' : 'mini';
        for (var j = 0; j < n; j++) back += '<div class="tile back ' + size + '"></div>';
        hand = '<div class="hand ' + ((pos === 1 || pos === 3) ? 'opp-v' : 'opp-h') + '">' + back + '</div>';
      }
      var focus = slot.contains(document.activeElement) && document.activeElement.dataset.idx;
      if (setMarkup(slot,card+melds+hand) && typeof focus === 'string') {
        var next = slot.querySelector('[data-idx="' + focus + '"]:not(:disabled)');
        if (next) next.focus({preventScroll:true});
      }
    }

    // 牌河（按视角旋转）
    for (var s2 = 0; s2 < 4; s2++) {
      var pos2 = (s2 - you + 4) % 4;
      var side = riverSides[pos2];
      if (!side) continue;
      var arr = (view.river && view.river[s2]) || [];
      var html = '';
      for (var k = 0; k < arr.length; k++) {
        var isLast = !!(view.lastDiscard && view.lastDiscard.seat === s2 && view.lastDiscard.tile === arr[k] && k === arr.length - 1);
        html += '<div class="tile small' + (isLast ? ' last' : '') + '" data-tile="' + arr[k] + '">' + T.faceSVG(arr[k]) + '</div>';
      }
      setMarkup(side,html);
    }

    // 中央提示
    var hint = '';
    if (view.phase === 'lack') hint = '定缺：选一门，手里不能留该门牌，未打完不能胡';
    else if (view.phase === 'claim') hint = '有人可以碰 / 杠 / 胡…';
    else if (view.phase === 'play') {
      var cp = view.players[view.current];
      hint = (view.current === you) ? (T.hasLack(view.hand || [], (view.players[you] || {}).lack) ? '轮到你 · 优先打缺门' : '轮到你出牌') : ((ctx.mode === 'local' ? (cp ? cp.name : '电脑') + ' 正在思考…' : '等待 ' + (cp ? cp.name : '对方') + ' 出牌'));
    } else if (view.phase === 'settle') hint = '本局结束 · 可查看结算';
    el('center-hint').textContent = hint;

    setMarkup(actionbar,actionbarHTML(view,ctx));
  }

  function btn(label, act, val, cls, disabled) {
    return '<button type="button" class="' + (cls || 'act-btn') + '" data-act="' + act + '" data-val="' +
      (val == null ? '' : val) + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
  }
  function note(t) { return '<span style="font-size:12px;color:#b8d3c6;background:rgba(7,31,24,.7);padding:7px 14px;border-radius:9px">' + t + '</span>'; }

  function actionbarHTML(view, ctx) {
    var you = ctx.mySeat, me = view.players[you] || {}, a = '';
    if (view.phase === 'lack') {
      if (me.lack < 0) {
        a += note('请选择缺门：') + ' ';
        var count = [0,0,0];
        (view.hand || []).forEach(function(id){count[T.suitOf(id)]++;});
        var min = Math.min.apply(Math,count);
        for (var i = 0; i < 3; i++) {
          var label = '定缺 ' + E.SUIT_CN[i] +
            (ctx.mode === 'local' ? '<small>' + count[i] + ' 张' + (count[i] === min ? ' · 建议' : '') + '</small>' : '');
          a += btn(label,'lack',i,'act-btn ' + (ctx.mode === 'local' && count[i] === min ? 'gold' : 'ghost') + ' lack-pick');
        }
      } else a += note('已定缺 ' + E.SUIT_CN[me.lack] + (ctx.mode === 'local' ? ' · 电脑正在定缺' : ' · 其他玩家正在定缺'));
    } else if (view.phase === 'claim') {
      var opts = view.myOptions || [];
      if (opts.length) {
        if (opts.indexOf('win') >= 0) a += btn('胡', 'claim', 'win', 'act-btn red');
        if (opts.indexOf('gang') >= 0) a += btn('杠', 'claim', 'gang', 'act-btn gold');
        if (opts.indexOf('peng') >= 0) a += btn('碰', 'claim', 'peng', 'act-btn');
        a += btn('过', 'claim', 'pass', 'act-btn ghost');
      } else a += note(ctx.mode === 'local' ? '电脑正在判断是否碰、杠或胡' : '等待其他家响应…');
    } else if (view.phase === 'play') {
      if (view.current === you) {
        if (view.myWin) a += btn('自摸胡', 'win', '', 'act-btn red');
        (view.myKongs || []).forEach(function (k) {
          a += btn((k.kind === 'added' ? '补杠 ' : '暗杠 ') + T.tileName(k.tile), 'kong', k.tile + ':' + k.kind, 'act-btn gold');
        });
        if (ctx.mode === 'local') a += btn('听牌提示','hint','','act-btn ghost');
        a += btn('出牌', 'discard', '', 'act-btn', ctx.selectedIndex == null || ctx.selectedIndex < 0);
      } else a += note(ctx.mode === 'local' ? '电脑回合' : '等待 ' + esc((view.players[view.current] || {}).name || '对方') + ' 出牌');
    } else if (view.phase === 'settle') {
      a += btn('本局结算','settlement','','act-btn ghost');
      a += btn(ctx.authority ? '下一局' : '等待房主开下一局', 'next', '',
        ctx.authority ? 'act-btn gold' : 'act-btn ghost', !ctx.authority);
    }
    return a;
  }

  /* ---------------- 动效 ---------------- */
  function flyTile(tileId, from, to, dur, delay) {
    if (!fx || tileId == null || tileId < 0) return;
    var d = document.createElement('div');
    d.className = 'fx-tile';
    d.innerHTML = T.tileHTML(tileId, { size: 'normal' });
    d.style.left = (from.x - 26) + 'px';
    d.style.top = (from.y - 38) + 'px';
    fx.appendChild(d);
    var dx = to.x - from.x, dy = to.y - from.y;
    try {
      var anim = d.animate([
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: 'translate(' + (dx * 0.55) + 'px,' + (dy * 0.55 - 46) + 'px) scale(1.06)', opacity: 1, offset: 0.55 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.72)', opacity: .15 }
      ], { duration: dur || 240, delay: delay || 0, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
      anim.onfinish = function () { if (d.parentNode) d.parentNode.removeChild(d); };
    } catch (e) { if (d.parentNode) d.parentNode.removeChild(d); }
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, (dur || 240) + (delay || 0) + 400);
  }

  function flashLabel(text,detail,win) {
    var chip = document.createElement('div');
    chip.className = 'reaction-fx' + (win ? ' is-win' : '');
    var word = document.createElement('strong'), info = document.createElement('span');
    word.textContent = text; info.textContent = detail;
    chip.append(word,info);
    var prior = fx.querySelector('.reaction-fx');
    if (prior) prior.remove();
    fx.appendChild(chip);
    var animation = chip.animate([
      {opacity:0,scale:.96,translate:'0 7px'},
      {opacity:1,scale:1,translate:'0 0',offset:.24},
      {opacity:1,scale:1,translate:'0 0',offset:.73},
      {opacity:0,scale:1,translate:'0 -7px'}
    ],{duration:win?1090:730,easing:'cubic-bezier(.16,1,.3,1)'});
    animation.finished.then(function(){chip.remove();},function(){chip.remove();});
  }

  function seatCenter(seat, you) {
    var pos = (seat - you + 4) % 4;
    var slot = slots[pos];
    if (!slot) return { x: 640, y: 380 };
    return center(slot.querySelector('.hand') || slot);
  }
  function riverCenter(seat, you) {
    var pos = (seat - you + 4) % 4;
    var side = riverSides[pos];
    if (!side) return { x: 640, y: 380 };
    var last = side.querySelector('.tile.last') || side.lastElementChild;
    return last ? center(last) : center(side);
  }

  function playEvents(events, view, ctx) {
    if (!events || !events.length || !stage) return;
    var settlement = events.some(function(e){return e.type==='settle';});
    if (motionAllowed()) {
      var you = ctx.mySeat;
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.type === 'deal') {
          var list = [];
          slots.forEach(function(slot,pos){
            slot.querySelectorAll('.hand .tile').forEach(function(tile,index){
              list.push({tile:tile,order:index*4+pos,b:box(tile)});
            });
          });
          list.forEach(function(item){
            var x = 640 - (item.b.x + item.b.w/2), y = 360 - (item.b.y + item.b.h/2);
            item.tile.animate([
              {transform:'translate(' + x*.47 + 'px,' + y*.47 + 'px) scale(.88)',opacity:0},
              {transform:'none',opacity:1}
            ],{duration:300,delay:item.order*7,fill:'backwards',easing:'cubic-bezier(.16,1,.3,1)'});
          });
        } else if (e.type === 'draw') {
          var slot = slots[(e.seat-you+4)%4];
          var last = slot && slot.querySelector('.hand .tile:last-child');
          if (last) last.animate([{transform:'translateX(11px) scale(.96)',opacity:.38},{transform:'none',opacity:1}],
            {duration:205,easing:'cubic-bezier(.16,1,.3,1)'});
        } else if (e.type === 'discard') {
          flyTile(e.tile,seatCenter(e.seat,you),riverCenter(e.seat,you),300);
        } else if (e.type === 'peng' || e.type === 'gang' || e.type === 'win') {
          var name = (view.players[e.seat] || {}).name || '玩家';
          flashLabel(e.type === 'peng' ? '碰' : e.type === 'gang' ? '杠' : '胡',
            name + (e.type === 'win' && e.fan ? ' · '+e.fan+' 番' : ''),e.type === 'win');
        }
      }
    }
    if (settlement) showSettle(view,ctx);
  }

  /* ---------------- 结算弹层 ---------------- */
  function showSettle(view, ctx) {
    var wins = view.wins || [];
    var h = '<button type="button" class="modal-close" data-act="closeModal">关闭 ✕</button>';
    h += '<h2>' + (wins.length && wins[0].type !== '查大叫' ? '本局结算' : '流局 · 查大叫') + '</h2>';
    h += '<div class="lead">第 ' + (view.round || 1) + ' 局 · 余牌 ' + (view.wallRemaining || 0) + ' · 血战到底</div>';
    if (wins.length) {
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        var p = view.players[w.seat] || {};
        h += '<div class="settle-winner"><div class="avatar">' + avatarImage(p.avatarKey) + '</div>' +
          '<b>' + esc(p.name || ('座位' + w.seat)) + '</b><span style="color:#f5d98f;font-size:13px">' +
          esc(w.type || '胡牌') + ' · ' + (w.fan || 0) + ' 番（封顶 ' + ((view.config || {}).maxFan || 8) + '）</span></div>';
        h += '<div class="fan-list">' + (w.names || []).map(function (n, k) {
          return '<span class="fan-item" style="animation-delay:' + (k * 0.06) + 's">' + esc(n) + '</span>';
        }).join('') + '</div>';
        h += '<div class="settle-hand">' + (w.hand || []).map(function (id) {
          return T.tileHTML(id, { size: 'small' });
        }).join('') + (w.melds || []).map(function (m) {
          return T.meldHTML(m.tid, m.n, m.type);
        }).join('') + '</div>';
        h += '<p style="text-align:center">本家本局 <b style="color:#7fe0a9">+' + (w.delta || 0) + '</b> 分</p>';
      }
    } else {
      h += '<p>牌墙摸完且无人胡牌。已执行查大叫：未听牌者按听牌者最大番赔付。</p>';
    }
    h += '<h3>分数变化</h3><table class="score-table"><tr><th>座位</th><th>昵称</th><th>本局</th><th>累计</th></tr>';
    var base = ctx.roundStartScores || [0, 0, 0, 0];
    for (var s = 0; s < 4; s++) {
      var pp = view.players[s] || {};
      var d = (pp.score || 0) - (base[s] || 0);
      h += '<tr><td>' + (s === ctx.mySeat ? '我' : ('座位' + s)) + '</td><td>' + esc(pp.name || ('玩家' + (s + 1))) +
        '</td><td class="' + (d >= 0 ? 'plus' : 'minus') + '">' + (d > 0 ? '+' : '') + d +
        '</td><td>' + (pp.score > 0 ? '+' : '') + (pp.score || 0) + '</td></tr>';
    }
    h += '</table><div class="row">' +
      (ctx.authority ? btn('下一局', 'next', '', 'act-btn gold') : btn('等待房主开下一局', 'noop', '', 'act-btn ghost', true)) +
      btn('关闭', 'closeModal', '', 'act-btn ghost') + '</div>';
    modal(h, { closable: true });
  }

  return {
    motionAllowed: motionAllowed, displayHand: displayHand,
    init: init, setScale: setScale, getScale: getScale, setContext: setContext,
    render: render, playEvents: playEvents, showSettle: showSettle,
    modal: modal, closeModal: closeModal, toast: toast, boot: boot, hideBoot: hideBoot,
    setTools: setTools, setTimer: setTimer, hideTimer: hideTimer, esc: esc
  };
});
