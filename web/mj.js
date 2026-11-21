/* 近传 · 四川麻将牌桌（血战到底）：定缺 → 摸打 → 胡牌结算 */
'use strict';

const MJ = { room: null, base: '', pid: null, timer: null, state: null, busy: false };

function mjEl(id){ return document.getElementById(id); }
const MJ_SUIT = ['万', '条', '筒'];

function mjTileHTML(t, cls){
  const s = Math.floor(t / 9), n = t % 9 + 1;
  return `<button class="mj-tile s${s}${cls || ''}" data-tile="${t}">
    <b>${n}</b><i>${MJ_SUIT[s]}</i></button>`;
}

function mjClose(){
  clearTimeout(MJ.timer);
  MJ.timer = null; MJ.room = null; MJ.state = null;
  mjEl('mjMask').classList.add('hidden');
}

function mjOpen(room, ip, port){
  MJ.room = room;
  MJ.pid = S.me.id;
  MJ.base = (ip && port) ? `http://${ip}:${port}` : '';
  MJ.state = null;
  mjEl('mjMask').classList.remove('hidden');
  mjEl('mjStatus').textContent = '进入牌桌…';
  mjPoll(true);
}

async function mjPoll(force){
  if(!MJ.room) return;
  const url = `${MJ.base}/api/mj/state?room=${encodeURIComponent(MJ.room)}&pid=${encodeURIComponent(MJ.pid)}`;
  try{
    const s = await fetch(url, { cache: 'no-store' }).then(r => r.json());
    if(s && s.ok){
      const changed = !MJ.state || s.updated !== MJ.state.updated || s.phase !== MJ.state.phase;
      MJ.state = s;
      if(changed || force) mjRender();
    } else if(s && s.error){
      mjEl('mjStatus').textContent = s.error;
    }
  }catch(e){
    mjEl('mjStatus').textContent = '连不上房主';
  }
  if(MJ.room) MJ.timer = setTimeout(() => mjPoll(false), 900);
}

async function mjAct(action){
  if(MJ.busy) return;
  MJ.busy = true;
  try{
    const r = await fetch(`${MJ.base}/api/mj/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: MJ.room, pid: MJ.pid, action }),
    }).then(x => x.json());
    if(!r || !r.ok) mjEl('mjStatus').textContent = (r && r.error) || '操作失败';
    else if(r.state){ MJ.state = r.state; mjRender(); }
  }catch(e){
    mjEl('mjStatus').textContent = '操作失败';
  }finally{
    MJ.busy = false;
  }
}

function mjRender(){
  const s = MJ.state;
  if(!s) return;
  const me = s.players.find(p => p.seat === s.seat) || {};
  const others = [1, 2, 3].map(d => s.players.find(p => p.seat === (s.seat + d) % 4)).filter(Boolean);
  const turnP = s.players.find(p => p.seat === s.turn) || {};

  mjEl('mjRoom').textContent = '房间 ' + String(s.id).slice(-6);
  mjEl('mjWall').textContent = '剩 ' + s.wall + ' 张';
  mjEl('mjStatus').textContent =
    s.phase === 'dingque' ? (me.que === null || me.que === undefined ? '请选一门定缺' : '等其他人定缺…')
    : s.phase === 'over' ? '本局结束'
    : (s.turn === s.seat ? '轮到你摸打' : `${turnP.name || ''} 出牌中`);

  // 三家
  ['mjSeat0', 'mjSeat1', 'mjSeat2'].forEach((id, i) => {
    const p = others[i];
    const box = mjEl(id);
    if(!p || !box) return;
    box.className = 'mj-seat' + (s.turn === p.seat ? ' turn' : '') + (p.done ? ' done' : '');
    box.innerHTML = `
      <div class="mj-av">${avatarImage(personProfile(p.id)?.avatarKey || p.avatarKey || (p.bot ? 'robot' : 'fox'))}</div>
      <div class="mj-meta">
        <div class="mj-name">${ESC(p.name)}${p.bot ? '<i class="seat-bot">托管</i>' : ''}</div>
        <div class="mj-sub">${p.done ? '已胡 · ' + ESC(p.win || '') : '剩 ' + p.count + ' 张'}
          ${p.que !== null && p.que !== undefined ? ' · 缺' + MJ_SUIT[p.que] : ''}</div>
      </div>
      ${p.done ? '<span class="mj-win">胡</span>' : ''}`;
  });

  // 桌面：最后一张打出的牌
  const lastEl = mjEl('mjLast');
  if(s.last){
    const who = s.players.find(p => p.seat === s.last.seat) || {};
    lastEl.innerHTML = `<div class="mj-last-who">${ESC(who.name || '')} 打出</div>
      ${mjTileHTML(s.last.tile, ' big')}`;
  } else {
    lastEl.innerHTML = '<div class="mj-last-who">牌桌</div>';
  }

  // 定缺
  const queBar = mjEl('mjQue');
  const needQue = s.phase === 'dingque' && (me.que === null || me.que === undefined);
  queBar.classList.toggle('hidden', !needQue);
  if(needQue && !queBar.dataset.ready){
    queBar.innerHTML = `<span class="mj-que-tip">选择要缺的一门（手里不能留）</span>
      ${[0, 1, 2].map(i => `<button class="btn sm" data-que="${i}">缺${MJ_SUIT[i]}</button>`).join('')}`;
    queBar.querySelectorAll('[data-que]').forEach(b => b.onclick = () => mjAct({ type: 'que', suit: Number(b.dataset.que) }));
    queBar.dataset.ready = '1';
  }
  if(!needQue) delete queBar.dataset.ready;

  // 手牌
  const handEl = mjEl('mjHand');
  const canPlay = s.phase === 'play' && s.turn === s.seat;
  handEl.innerHTML = (s.hand || []).map(t => mjTileHTML(t, canPlay ? '' : ' locked')).join('');
  handEl.querySelectorAll('.mj-tile').forEach(btn => {
    btn.onclick = () => {
      if(!canPlay) return;
      mjAct({ type: 'discard', tile: Number(btn.dataset.tile) });
    };
  });

  // 我的状态
  mjEl('mjMe').innerHTML = `<b>${ESC(S.me.name || '我')}</b>
    ${me.que !== null && me.que !== undefined ? '<span class="mj-me-que">缺' + MJ_SUIT[me.que] + '</span>' : ''}
    <span class="mj-me-score">${me.score || 0} 分</span>
    ${me.done ? '<span class="mj-win">已胡 · ' + ESC(me.win || '') + '</span>' : ''}`;

  // 结算
  const res = mjEl('mjResult');
  if(s.phase === 'over'){
    const rows = s.players.map(p => `<div class="mj-row">
      <span>${ESC(p.name)}${p.done ? ' · ' + ESC(p.win || '胡') : ''}</span>
      <b class="${p.score >= 0 ? 'plus' : 'minus'}">${p.score >= 0 ? '+' : ''}${p.score}</b></div>`).join('');
    res.classList.remove('hidden');
    res.innerHTML = `<div class="gr-card"><div class="gr-title">本局结束</div>
      <div class="mj-score">${rows}</div>
      <button class="btn primary" id="mjAgain">知道了</button></div>`;
    mjEl('mjAgain').onclick = () => mjClose();
  } else {
    res.classList.add('hidden');
  }
}

async function mjInviteCurrent(){
  if(!current){ toast('先选一个好友或群'); return; }
  const r = await API('/api/mj/create', {});
  if(!r || !r.ok){ toast((r && r.error) || '开桌失败'); return; }
  await API('/api/game/invite', { conversation: current, room: r.room });
  getState();
  mjOpen(r.room, '127.0.0.1', S.me.http);
}

document.addEventListener('DOMContentLoaded', () => {
  const close = mjEl('mjClose');
  if(close) close.onclick = () => mjClose();
});
