/* 近传 · 小游戏桌面：房间选择 + 斗地主（房主进程当裁判，其他人轮询状态） */
'use strict';

const GAME = {
  room: null, base: '', pid: null, timer: null, state: null, sel: new Set(), busy: false,
};

const SUITS = ['♠', '♥', '♣', '♦'];
const RANK = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };

function gameEl(id){ return document.getElementById(id); }

/* ---------------- 牌面 ---------------- */
function cardHTML(v, idx, extra){
  const cls = extra || '';
  if(v >= 16){
    return `<button class="pc joker${v === 17 ? ' big' : ''}${cls}" style="--i:${idx}" data-val="${v}" data-i="${idx}">
      <span class="pc-r">${v === 17 ? '大' : '小'}</span><span class="pc-s">王</span>
      <span class="pc-big">JOKER</span></button>`;
  }
  const suit = SUITS[(v + idx) % 4];
  const red = suit === '♥' || suit === '♦';
  return `<button class="pc${red ? ' red' : ''}${cls}" style="--i:${idx}" data-val="${v}" data-i="${idx}">
    <span class="pc-r">${RANK[v]}</span><span class="pc-s">${suit}</span>
    <span class="pc-big">${suit}</span></button>`;
}

/* ---------------- 牌桌开合 ---------------- */
function gameClose(){
  clearTimeout(GAME.timer);
  GAME.timer = null; GAME.room = null; GAME.state = null; GAME.sel.clear();
  const mask = gameEl('gameMask');
  if(mask) mask.classList.add('hidden');
}

function gameOpen(room, hostId, ip, port){
  GAME.room = room;
  GAME.pid = S.me.id;
  GAME.base = (ip && port) ? `http://${ip}:${port}` : '';
  GAME.sel.clear();
  GAME.state = null;
  GAME.dealPending = true;
  gameEl('gameMask').classList.remove('hidden');
  gameEl('gameStatus').textContent = '进入牌桌…';
  gameEl('gameResult').classList.add('hidden');
  gamePoll(true);
}

async function gamePoll(force){
  if(!GAME.room) return;
  const url = `${GAME.base}/api/game/state?room=${encodeURIComponent(GAME.room)}&pid=${encodeURIComponent(GAME.pid)}`;
  try{
    const s = await fetch(url, { cache: 'no-store' }).then(r => r.json());
    if(s && s.ok){
      const changed = !GAME.state || s.updatedAt !== GAME.state.updatedAt ||
        s.phase !== GAME.state.phase ||
        JSON.stringify(s.last) !== JSON.stringify(GAME.state.last);
      GAME.state = s;
      if(changed || force) gameRender();
    } else if(s && s.error){
      gameEl('gameStatus').textContent = s.error;
    }
  }catch(e){
    gameEl('gameStatus').textContent = '连不上房主，检查对方是否还在';
  }
  if(GAME.room) GAME.timer = setTimeout(() => gamePoll(false), 700);
}

async function gameAct(action){
  if(GAME.busy) return;
  GAME.busy = true;
  try{
    const r = await fetch(`${GAME.base}/api/game/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: GAME.room, pid: GAME.pid, action }),
    }).then(x => x.json());
    if(!r || !r.ok){
      gameEl('gameStatus').textContent = (r && r.error) || '操作失败';
    } else if(r.state){
      GAME.state = r.state;
      GAME.sel.clear();
      gameRender();
    }
  }catch(e){
    gameEl('gameStatus').textContent = '操作失败：' + (e.message || e);
  }finally{
    GAME.busy = false;
  }
}

/* ---------------- 渲染 ---------------- */
function gameRender(){
  const s = GAME.state;
  if(!s) return;
  const mine = s.players.find(p => p.seat === s.seat) || {};
  const others = s.players.filter(p => p.seat !== s.seat);
  const turnP = s.players.find(p => p.seat === s.turn) || {};

  gameEl('gameRoom').textContent = '房间 ' + String(s.id).slice(-6) +
    (s.phase === 'bid'
      ? ' · 最高 ' + ((s.bid && s.bid.high) || 0) + ' 分'
      : ' · 底分 ' + (s.base || 1) + ' × ' + (s.mult || 1) + ' 倍');
  gameEl('gameStatus').textContent =
    s.phase === 'bid' ? (s.turn === s.seat ? '轮到你叫地主' : `${turnP.name || ''} 正在叫地主`)
    : s.phase === 'play' ? (s.turn === s.seat ? '轮到你出牌' : `${turnP.name || ''} 出牌中`)
    : s.phase === 'over' ? '本局结束' : '等待玩家…';

  // 底牌
  const bottom = gameEl('gameBottom');
  bottom.innerHTML = (s.bottom || []).length
    ? `<span class="gb-label">底牌</span>${s.bottom.map((v, i) => cardHTML(v, i, ' mini')).join('')}`
    : '';

  // 对手
  others.slice(0, 2).forEach((p, i) => {
    const box = gameEl('gameSeat' + i);
    if(!box) return;
    const act = (s.actions || {})[p.seat];
    const actHTML = act
      ? (act.pass
          ? '<div class="seat-play"><span class="pass-tag">不要</span></div>'
          : `<div class="seat-play">${act.cards.map((v, k) => cardHTML(v, k, ' mini')).join('')}</div>`)
      : '';
    box.className = 'seat' + (s.turn === p.seat ? ' turn' : '') + (p.landlord ? ' lord' : '');
    box.innerHTML = `
      <div class="seat-av">${avatarImage(personProfile(p.id)?.avatarKey || p.avatarKey || (p.bot ? 'robot' : 'fox'))}</div>
      <div class="seat-meta">
        <div class="seat-name">${ESC(p.name)}${p.bot ? '<i class="seat-bot">托管</i>' : ''}</div>
        <div class="seat-count">剩 ${p.count} 张${p.landlord ? ' · 地主' : ''}</div>
      </div>
      ${p.landlord ? '<span class="seat-crown">地主</span>' : ''}
      ${actHTML}`;
  });

  // 桌面上的牌：只显示「别人」的当前出牌；自己出的挂在手牌上方，
  // 否则自己出完、下家一出，自己刚出的牌就从桌面上消失了。
  const lastEl = gameEl('gameLast');
  if(s.last && s.last.cards && s.last.seat !== s.seat){
    const who = s.players.find(p => p.seat === s.last.seat) || {};
    lastEl.innerHTML = `<div class="tl-who">${ESC(who.name || '')} 出了</div>
      <div class="tl-cards">${s.last.cards.map((v, i) => cardHTML(v, i, ' mid')).join('')}</div>`;
  } else {
    lastEl.innerHTML = '<div class="tl-empty">' +
      (s.turn === s.seat ? '轮到你出牌' : '自由出牌') + '</div>';
  }

  // 我上一手出的牌（固定显示在手牌上方）
  const myAct = (s.actions || {})[s.seat];
  const myPlay = gameEl('myPlay');
  if(myPlay){
    myPlay.innerHTML = myAct
      ? (myAct.pass
          ? '<span class="pass-tag">不要</span>'
          : `<div class="tl-who">你出了</div>
             <div class="tl-cards">${myAct.cards.map((v, i) => cardHTML(v, i, ' mini')).join('')}</div>`)
      : '';
  }

  // 记牌器：场上还剩哪些牌没出（自己手牌 + 已出的牌都扣除）
  const counter = gameEl('gameCounter');
  if(counter){
    const seen = {};
    (s.hand || []).forEach(v => { seen[v] = (seen[v] || 0) + 1; });
    (s.played || []).forEach(v => { seen[v] = (seen[v] || 0) + 1; });
    const rows = [];
    for(let v = 3; v <= 15; v++){
      const left = 4 - (seen[v] || 0);
      if(left > 0) rows.push('<span class="ct">' + RANK[v] + '<i>' + left + '</i></span>');
    }
    [16, 17].forEach(v => {
      if(!seen[v]) rows.push('<span class="ct">' + (v === 17 ? '大王' : '小王') + '<i>1</i></span>');
    });
    counter.innerHTML = '<span class="ct-title">记牌</span>' + rows.join('');
  }

  // 手牌
  const handEl = gameEl('gameHand');
  handEl.innerHTML = (s.hand || []).map((v, i) => cardHTML(v, i, GAME.sel.has(i) ? ' sel' : '')).join('');
  if(GAME.dealPending && (s.hand || []).length >= 17){
    handEl.classList.add('deal');
    GAME.dealPending = false;
    setTimeout(() => handEl.classList.remove('deal'), 1000);
  }
  handEl.querySelectorAll('.pc').forEach((btn, i) => {
    btn.onclick = () => {
      if(GAME.sel.has(i)) GAME.sel.delete(i); else GAME.sel.add(i);
      btn.classList.toggle('sel');
      gameEl('gameStatus').textContent = GAME.sel.size
        ? `已选 ${GAME.sel.size} 张 · 点「出牌」` : (s.turn === s.seat ? '轮到你出牌' : '');
    };
  });

  // 按钮
  const myTurn = s.turn === s.seat && (s.phase === 'bid' || s.phase === 'play');
  gameEl('gameBid').classList.toggle('hidden', !(myTurn && s.phase === 'bid'));
  gameEl('gamePlay').classList.toggle('hidden', !(myTurn && s.phase === 'play'));
  gameEl('gameLeave').classList.toggle('hidden', s.phase === 'over' || myTurn);

  // 结算
  const res = gameEl('gameResult');
  if(s.phase === 'over'){
    const win = s.winner === 'landlord'
      ? (mine.landlord ? '你赢了（地主）' : '地主赢了')
      : (mine.landlord ? '农民赢了' : '你赢了（农民）');
    res.classList.remove('hidden');
    res.innerHTML = `<div class="gr-card">
      <div class="gr-title">${win}</div>
      <div class="gr-sub">底分 ${(s.result && s.result.base) || 1} × 倍数 ${(s.result && s.result.mult) || 1}
        = ${(s.result && s.result.score) || 1} 分<br>${ESC((s.log || []).slice(-1)[0] || '')}</div>
      <button class="btn primary" id="gameAgain">知道了</button></div>`;
    const again = gameEl('gameAgain');
    if(again) again.onclick = () => gameClose();
  } else {
    res.classList.add('hidden');
  }
}

/* ---------------- 提示 / 出牌 ---------------- */
function gameSelectedCards(){
  const s = GAME.state;
  if(!s) return [];
  return Array.from(GAME.sel).sort((a, b) => a - b).map(i => s.hand[i]);
}

function gameHint(){
  const s = GAME.state;
  if(!s || !s.hand) return;
  const hand = s.hand;
  const last = s.last;
  const cnt = {};
  hand.forEach((v, i) => { (cnt[v] = cnt[v] || []).push(i); });
  const pickOf = (v, n) => (cnt[v] || []).slice(0, n);
  let pick = null;

  if(!last || last.seat === s.seat){
    // 自由出牌：出最小的一张
    pick = pickOf(hand[0], 1);
  } else {
    const t = last.type || [];
    const kind = t[0], val = t[1] || 0, len = t[2] || 1;
    const vals = Object.keys(cnt).map(Number).sort((a, b) => a - b);
    if(kind === 'single' || kind === 'pair' || kind === 'triple'){
      const n = { single: 1, pair: 2, triple: 3 }[kind];
      const v = vals.find(x => x > val && cnt[x].length >= n);
      if(v) pick = pickOf(v, n);
    } else if(kind === 'straight' || kind === 'pairs' || kind === 'plane'){
      const step = kind === 'straight' ? 1 : (kind === 'pairs' ? 2 : 3);
      const size = kind === 'pairs' ? 2 : (kind === 'plane' ? 3 : 1);
      for(let start = val + 1; start <= 14 - (len - 1) * step; start++){
        const seq = [];
        for(let k = 0; k < len; k++){
          const v = start + k * step;
          if(!cnt[v] || cnt[v].length < size) { seq.length = 0; break; }
          seq.push(...pickOf(v, size));
        }
        if(seq.length){ pick = seq; break; }
      }
    }
    if(!pick){
      const four = vals.find(x => cnt[x].length === 4 && (kind !== 'bomb' || x > val));
      if(four) pick = pickOf(four, 4);
    }
    if(!pick && cnt[16] && cnt[17]) pick = [...pickOf(16, 1), ...pickOf(17, 1)];
  }
  if(!pick){ gameEl('gameStatus').textContent = '没有能压过的牌'; return; }
  GAME.sel = new Set(pick);
  gameRender();
  gameEl('gameStatus').textContent = '已选提示牌，再点「出牌」';
}

/* ---------------- 四川麻将：练习和联机各自拥有独立会话 ---------------- */
let mahjongDesk = null;
let lastMahjongProfile = '';

function openMahjongModes(){
  if(mahjongDesk) { restoreMahjongDesk(); return; }
  openModal('<h3>四川麻将</h3><p class="sub">血战到底 · 选择开局方式</p>' +
    '<div class="lobby">' +
    '<button class="lobby-card" id="pickPractice"><span class="lc-art practice">练</span><span class="lc-body"><strong class="lc-name">单人练习</strong><span class="lc-desc">三家电脑 · 离线游玩 · 无倒计时</span></span><span class="lc-go">开始</span></button>' +
    '<button class="lobby-card" id="pickMahjong"><span class="lc-art mj">友</span><span class="lc-body"><strong class="lc-name">好友联机</strong><span class="lc-desc">' +
    (current ? '邀请发到当前会话 · 四人到齐开局' : '先打开一个会话，再发送联机邀请') +
    '</span></span><span class="lc-go">开桌</span></button></div>' +
    '<div class="modal-actions"><button class="btn" id="mCancel">关闭</button></div>');
  $('mCancel').onclick = () => closeModal(true);
  $('pickPractice').onclick = () => {
    closeModal(true);
    openMahjongDesk({mode:'practice'});
  };
  $('pickMahjong').disabled = !current;
  $('pickMahjong').onclick = () => {
    closeModal(true);
    openMahjongDesk({
      mode:'host', room:'r' + Math.random().toString(36).slice(2, 8),
      host:location.hostname, port:Number(S.me.http || location.port || 8765), conversation:current
    });
  };
}

function restoreMahjongDesk(){
  $('mjFrameMask').classList.remove('hidden');
  $('mjFrameMin').focus({preventScroll:true});
}

function openMahjongDesk(desk){
  if(mahjongDesk){
    restoreMahjongDesk();
    if(mahjongDesk.room !== desk.room) toast('请先退出当前牌桌，再加入新牌桌');
    return;
  }
  mahjongDesk = desk;
  lastMahjongProfile = '';
  const query = new URLSearchParams({
    mode:desk.mode === 'practice' ? 'practice' : 'lan',
    name:S.me.name || '我',
    avatar:normalizeAvatar(S.me.avatarKey),
    motion:reducedMotion() ? 'reduced' : 'full'
  });
  if(desk.mode !== 'practice'){
    query.set('room',desk.room); query.set('host',desk.host); query.set('port',desk.port);
    query.set('seat',desk.mode === 'host' ? '0' : 'auto');
    query.set('isHost',desk.mode === 'host' ? '1' : '0');
  }
  $('mjFrame').src = '/games/majiang/index.html?' + query;
  restoreMahjongDesk();
}

function joinMahjongInvite({room,ip,port,hostId,own}){
  if(own || (hostId && hostId === S.me.id)){
    if(mahjongDesk?.mode === 'host' && mahjongDesk.room === room) restoreMahjongDesk();
    else toast('这张牌桌已关闭，请重新开桌');
    return;
  }
  const peer = hostId && personProfile(hostId);
  const host = peer?.ip || ip;
  const targetPort = Number(peer?.http || port);
  if(!room || !host || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535){
    toast('邀请信息不完整，请让房主重发邀请');
    return;
  }
  openMahjongDesk({mode:'guest', room, host, port:targetPort});
}

function syncMahjongProfile(){
  if(!mahjongDesk) return;
  const name = S.me.name || '我', avatarKey = normalizeAvatar(S.me.avatarKey);
  const signature = JSON.stringify([name,avatarKey]);
  if(signature === lastMahjongProfile) return;
  lastMahjongProfile = signature;
  $('mjFrame').contentWindow.postMessage({type:'jinchuan-mahjong-profile',name,avatarKey},location.origin);
}

async function publishMahjongInvite(room){
  const desk = mahjongDesk;
  if(!desk || desk.mode !== 'host' || desk.room !== room || desk.invited) return;
  desk.invited = true;
  try{
    const r = await API('/api/game/invite', {conversation:desk.conversation, room, kind:'majiang'});
    if(mahjongDesk === desk){
      toast(r?.ok
        ? (r.failed ? '邀请已发给在线成员' : '邀请已发送')
        : (r?.error || '邀请未送达，请确认好友在线'));
    }
    if(r?.ok) getState();
  }catch(e){
    if(mahjongDesk === desk) toast('邀请未送达，请检查本地连接后重新开桌');
  }
}

function hideMahjongDesk(){
  $('mjFrameMask').classList.add('hidden');
  const origin = surface === 'activities' ? $('activityList').querySelector('[data-activity="majiang"]') : $('btnGame');
  (origin || $('navGames')).focus({preventScroll:true});
}

function closeMahjongDesk(){
  if(!mahjongDesk) return;
  mahjongDesk = null;
  $('mjFrame').src = 'about:blank';
  hideMahjongDesk();
}

document.addEventListener('DOMContentLoaded', () => {
  $('mjFrame').addEventListener('load', () => { lastMahjongProfile = ''; syncMahjongProfile(); });
  $('mjFrameMin').onclick = hideMahjongDesk;
  $('mjFrameClose').onclick = closeMahjongDesk;
  $('mjFrameMask').addEventListener('mousedown', e => {
    if(e.target === $('mjFrameMask')) hideMahjongDesk();
  });
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && !$('mjFrameMask').classList.contains('hidden')) hideMahjongDesk();
  });
  window.addEventListener('message', e => {
    if(e.origin !== location.origin || e.source !== $('mjFrame').contentWindow || !e.data) return;
    if(e.data.type === 'jinchuan-mahjong-close') closeMahjongDesk();
    else if(e.data.type === 'jinchuan-mahjong-ready') publishMahjongInvite(e.data.room);
  });
});
