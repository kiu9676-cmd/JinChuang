/* 近传 前端逻辑：好友 / 聊天 / 文件与文件夹 / 实时进度 / QQ 式桌面体验 */
'use strict';

let S = { me:{}, config:{}, peers:[], groups:[], messages:{}, transfers:[], platform:'', unread:{}, desktop:false };
let current = null;
let surface = 'chats';
let chatScroll = null;
let ws = null, wsTimer = null;
const retryActions = new Map();
let outTasks = {};                 // 本端「发送中」任务
let pendingMap = {};               // 本端临时气泡（上传中即显示进度）
let unread = {};                   // 未读角标（以服务端计数为准）
let prevCounts = {};               // 用于探测「新消息」放提示音
let peerSearch = '';
let collapsedGroups = Object.create(null);          // 分组折叠状态
let replyTo = null;                // 当前引用回复的消息
let drafts = [];                   // 当前会话「待发送」附件（不会自动发出）
const draftMap = {};               // 每个好友独立草稿：{ text, groups }
const RECALL_MS = 120000;          // 撤回时限（QQ 为 2 分钟）

const $ = id => document.getElementById(id);
const ESC = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtSize = n => { n = Number(n)||0; if(n < 1024) return n + ' B';
  const u=['KB','MB','GB','TB']; let i=-1; do{ n/=1024; i++; }while(n>=1024 && i<3);
  return n.toFixed(1)+' '+u[i]; };
const fmtSpeed = b => !b ? '' : fmtSize(b) + '/s';
const fmtTime = t => { const d=new Date(Number(t)||Date.now());
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
const fmtDay = t => { const d = new Date(Number(t)||Date.now()), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate()-1);
  if(sameDay) return fmtTime(t);
  if(d.toDateString() === yest.toDateString()) return '昨天';
  return (d.getMonth()+1) + '-' + d.getDate(); };
const pct = t => !t.size ? 0 : Math.min(100, Math.round(t.doneBytes / t.size * 100));
const escAttr = s => ESC(s).replace(/'/g,'&#39;');
const totalUnread = () => Object.values(unread).reduce((a,b) => a+b, 0);

async function API(path, body){
  const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'},
                                body: JSON.stringify(body || {}) });
  return r.json();
}
/* 全局状态拉取：带序号防乱序（旧快照后到会把刚发出的消息“吞”掉） */
let stateSeq = 0;
async function getState(){
  const seq = ++stateSeq;
  try{
    const r = await fetch('/api/state'); const d = await r.json();
    if(!d.ok) return;
    if(seq !== stateSeq) return;                  // 有更新的请求在路上，丢弃这次旧快照
    // 探测新入站消息（放提示音 / 浏览器模式系统通知）
    for(const p of (d.peers||[])){
      const n = (d.messages[p.id] || []).length;
      if(prevCounts[p.id] !== undefined && n > prevCounts[p.id]){
        const last = (d.messages[p.id] || [])[n-1];
        if(last && last.dir === 'in' && current !== p.id) onNewMessage(p, last);
      }
      prevCounts[p.id] = n;
    }
    S = d;
    syncAppearanceFromState();
    unread = Object.assign({}, d.unread || {});
    // 合并本地发送任务，避免全量刷新覆盖实时进度
    for(const t of Object.values(outTasks)){
      const i = S.transfers.findIndex(x => x.id === t.id);
      if(i >= 0) S.transfers[i] = t; else S.transfers.push(t);
    }
    renderAll();
  }catch(e){ /* 服务重启中，稍后由 WS 重连恢复 */ }
}

/* ---------------- 新消息：声音 / 标题角标 / 浏览器模式系统通知 ---------------- */
function onNewMessage(peer, msg){
  renderTitle();
  const dnd = S.config && S.config.dnd;
  const mute = peer && peer.mute;
  const sound = !S.config || S.config.sound !== false;
  if(!dnd && !mute && sound) ding();
  if(!S.desktop && !dnd && !mute && 'Notification' in window){
    try{
      if(Notification.permission === 'granted')
        new Notification(peer.displayName || '好友', { body: msgPreviewText(msg) });
      else if(Notification.permission === 'default')
        Notification.requestPermission();
    }catch(e){}
  }
}
function msgPreviewText(m){
  if(m.type === 'image') return '[图片]';
  if(m.type === 'folder') return '[文件夹] ' + (m.fileName || '');
  if(m.type === 'file') return '[文件] ' + (m.fileName || '');
  if(m.type === 'recalled') return '撤回了一条消息';
  return m.text || '新消息';
}
let audioCtx = null;
function ding(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    [[880, 0], [1174.7, 0.12]].forEach(([f, dt]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.001, t0+dt);
      g.gain.exponentialRampToValueAtTime(0.12, t0+dt+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0+dt+0.35);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0+dt); o.stop(t0+dt+0.4);
    });
  }catch(e){}
}
function renderTitle(){
  const n = totalUnread();
  document.title = (n ? `(${n}) ` : '') + '近传';
}

/* ---------------- WebSocket ---------------- */
function connectWS(){
  try{ ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://') + location.host + '/ws'); }
  catch(e){ scheduleReconnect(); return; }
  ws.onopen = () => { setHint('本地服务已连接'); };
  ws.onmessage = ev => {
    let m; try{ m = JSON.parse(ev.data); }catch(e){ return; }
    if(m.type === 'refresh') getState();
    else if(m.type === 'progress'){
      const t = m.task, i = S.transfers.findIndex(x => x.id === t.id);
      if(i >= 0) S.transfers[i] = t; else S.transfers.push(t);
      if(t.retryable && t.peerId === current) renderMessages();
      renderTransfers(); updateBubbleProgress(t.msgId, taskPct(t));
    }
    else if(m.type === 'toast') toast(m.from + ' ' + m.text);
    else if(m.type === 'hello') setHint('本地服务已连接');
  };
  ws.onclose = () => { setHint('连接断开，正在重连…', true); scheduleReconnect(); };
  ws.onerror = () => {};
}
function scheduleReconnect(){
  if(wsTimer) return;
  wsTimer = setTimeout(() => { wsTimer = null; connectWS(); getState(); }, 1500);
}
function setHint(t, bad){
  const el = $('hint'), detail = bad ? t : '';
  if(el.textContent !== detail) el.textContent = detail;
  el.classList.toggle('bad', !!bad);
  const pill = $('connectionState'), label = $('connectionLabel');
  const next = bad ? '正在重连' : '本地服务已连接';
  pill.classList.toggle('bad', !!bad);
  pill.classList.toggle('online', !bad);
  if(label.textContent !== next) label.textContent = next;
}

function reducedMotion(){
  return document.documentElement.dataset.motion === 'reduced' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 关闭只等当前出场动画；精简动效直接关闭，重新打开会使旧回调失效。
const exits = new WeakMap();
function cancelExit(el){
  exits.delete(el);
  el.classList.remove('closing');
}
function onMotionEnd(el, callback){
  const exit = {};
  exits.set(el, exit);
  const finish = () => {
    if(exits.get(el) !== exit) return;
    exits.delete(el);
    callback();
  };
  const animations = reducedMotion() ? [] : el.getAnimations();
  if(animations.length) Promise.allSettled(animations.map(a => a.finished)).then(finish);
  else finish();
}
function hideSurface(el, after){
  if(el.classList.contains('hidden') || el.classList.contains('closing')) return;
  el.classList.add('closing');
  onMotionEnd(el, () => {
    el.classList.add('hidden');
    el.classList.remove('closing');
    if(after) after();
  });
}


/* ---------------- toast：堆叠式，多条提示互不打断 ---------------- */
const TOASTS = [];
function toast(text){
  const host = $('toast');
  if(!host) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  host.appendChild(el);
  TOASTS.push(el);
  while(TOASTS.length > 3){
    const old = TOASTS.shift();
    if(old && old.parentNode) old.parentNode.removeChild(old);
  }
  const kill = () => {
    if(el._dead) return;
    el._dead = true;
    el.classList.add('out');
    onMotionEnd(el, () => el.remove());
    const i = TOASTS.indexOf(el); if(i >= 0) TOASTS.splice(i, 1);
  };
  el._t = setTimeout(kill, 2400);
  el.onclick = kill;
}

/* ---------------- 界面缩放（Ctrl +/-/0） ---------------- */
const ZOOM_KEY = 'lb.zoom';
function applyZoom(v, persist){
  const z = Math.max(0.8, Math.min(1.6, Math.round(v * 100) / 100));
  document.documentElement.style.zoom = z === 1 ? '' : String(z);
  if(persist !== false){ try{ localStorage.setItem(ZOOM_KEY, String(z)); }catch(e){} }
  return z;
}
function currentZoom(){
  let z = 1;
  try{ z = parseFloat(localStorage.getItem(ZOOM_KEY) || '1') || 1; }catch(e){}
  return Math.max(0.8, Math.min(1.6, z));
}
function zoomBy(delta){ applyZoom(currentZoom() + delta); }
document.addEventListener('keydown', e => {
  if(!(e.ctrlKey || e.metaKey)) return;
  if(e.key === '=' || e.key === '+'){ e.preventDefault(); zoomBy(0.1); }
  else if(e.key === '-'){ e.preventDefault(); zoomBy(-0.1); }
  else if(e.key === '0'){ e.preventDefault(); applyZoom(1); }
});
document.addEventListener('wheel', e => {
  if(!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  zoomBy(e.deltaY > 0 ? -0.1 : 0.1);
}, { passive: false });

/* ---------------- 主题 / 动效 / 提示音偏好 ---------------- */
const THEME_KEY = 'lb.theme';
const MOTION_KEY = 'lb.motion';
const THEME_ORDER = ['light', 'dark', 'auto'];
const MOTION_ORDER = ['full', 'reduced'];
let themePref = 'auto';

function prefersDark(){
  try{ return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  catch(e){ return false; }
}
function resolveTheme(pref){
  if(pref === 'light' || pref === 'dark') return pref;
  return prefersDark() ? 'dark' : 'light';
}
function applyTheme(pref, persist){
  themePref = THEME_ORDER.includes(pref) ? pref : 'auto';
  const d = document.documentElement;
  const resolved = resolveTheme(themePref);
  if(d.dataset.theme !== resolved) d.dataset.theme = resolved;
  d.dataset.themePref = themePref;
  if(persist !== false){ try{ localStorage.setItem(THEME_KEY, themePref); }catch(e){} }
}
function applyMotion(mode, persist){
  const d = document.documentElement;
  const v = MOTION_ORDER.includes(mode) ? mode : 'full';
  if(d.dataset.motion !== v) d.dataset.motion = v;
  if(persist !== false){ try{ localStorage.setItem(MOTION_KEY, v); }catch(e){} }
}
function currentThemePref(){
  const c = (S.config && S.config.theme) || '';
  if(THEME_ORDER.includes(c)) return c;
  try{ return localStorage.getItem(THEME_KEY) || 'auto'; }catch(e){ return 'auto'; }
}
function currentMotion(){
  const c = (S.config && S.config.motion) || '';
  if(MOTION_ORDER.includes(c)) return c;
  try{ return localStorage.getItem(MOTION_KEY) || 'full'; }catch(e){ return 'full'; }
}
function syncAppearanceFromState(){
  if(!S.config) return;
  const t = S.config.theme, m = S.config.motion;
  if(THEME_ORDER.includes(t)) applyTheme(t);
  if(MOTION_ORDER.includes(m)) applyMotion(m);
}
try{
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if(themePref === 'auto') applyTheme('auto', false);
  });
}catch(e){}

/* ---------------- 渲染 ---------------- */
function renderAll(){ renderMe(); renderPeers(); renderTransfers(); renderHeader(); renderMessages(); renderChatSearch(); renderOpenProfiles(); renderTitle(); }

function renderMe(){
  $('meName').textContent = S.me.name || '我';
  syncAvatar($('meAvatar'), S.me.avatarKey);
  if(typeof syncMahjongProfile === 'function') syncMahjongProfile();
  $('meSub').textContent = (S.me.ip || '') + ':' + (S.me.http || '') +
    (S.platform ? '  ·  ' + S.platform : '');
  $('peerCount').textContent = S.peers.length + (S.groups || []).length;
}

/* ---------------- 会话解析：好友 or 群 ---------------- */
function groupOf(id){ return (S.groups || []).find(g => g.id === id) || null; }
function isGroupConv(id){ return !!groupOf(id); }
function convOf(id){ return S.peers.find(x => x.id === id) || groupOf(id) || null; }
function personProfile(id){
  return id === S.me.id ? S.me : S.peers.find(p => p.id === id);
}
function profileName(profile, fallback = '好友'){
  return profile?.displayName || profile?.name || fallback;
}
function renderOpenProfiles(){
  $('modal').querySelectorAll('[data-live-profile]').forEach(row => {
    const profile = personProfile(row.dataset.liveProfile);
    syncAvatar(row.querySelector('.avatar'), profile?.avatarKey);
    const label = row.querySelector('[data-profile-name]');
    if(label) label.textContent = profileName(profile);
  });
}
/* QQ 式好友列表：置顶 > 分组 > 在线排序；行内显示最近消息、时间、未读角标 */
function renderPeers(){
  const box = $('peerList');
  const kw = peerSearch.trim().toLowerCase();
  const filter = p => !kw || (p.displayName||'').toLowerCase().includes(kw) ||
    (p.name||'').toLowerCase().includes(kw) || (p.ip||'').includes(kw);
  let peers = S.peers.filter(filter);
  const groups = (S.groups || []).filter(g => !kw ||
    (g.name || '').toLowerCase().includes(kw));

  if(!S.peers.length && !groups.length){
    setPeerList('<div class="peer-empty">还没有会话</div>');
    return;
  }
  if(!peers.length && !groups.length){
    setPeerList('<div class="peer-empty"><strong>没有找到会话</strong>试试其他名称或 IP。</div>');
    return;
  }

  const lastMsgOf = pid => {
    const arr = S.messages[pid] || [];
    return arr.length ? arr[arr.length-1] : null;
  };
  const rowHTML = p => {
    const last = lastMsgOf(p.id);
    const n = unread[p.id] || 0;
    return `
    <div class="peer ${p.online?'':'off'} ${current===p.id?'active':''}" data-id="${escAttr(p.id)}" role="button" tabindex="0" aria-pressed="${current===p.id}">
      <div class="avatar-wrap">
        <div class="avatar" data-avatar="${escAttr(p.id)}">${avatarImage(p.avatarKey)}</div>
        <span class="dot ${p.online?'on':''}"></span>
      </div>
      <div class="peer-main">
        <div class="peer-row1">
          <span class="peer-name">${ESC(p.displayName)}</span>
          ${p.mute?'<span class="mute-ico" title="消息免打扰">🔇</span>':''}
          ${p.pinned?'<span class="pin">置顶</span>':''}
          <span class="peer-time">${last?fmtDay(last.time):''}</span>
        </div>
        <div class="peer-msg">${last?ESC(msgPreviewText(last)):'<span class="peer-group-inline">'+ (p.group?ESC(p.group)+' · ':'') + ESC(p.platform||'') +'</span>'}</div>
      </div>
      ${n?`<span class="badge">${n>99?'99+':n}</span>`:''}
    </div>`;
  };
  const groupRowHTML = g => {
    const last = lastMsgOf(g.id);
    const n = unread[g.id] || 0;
    const preview = last
      ? ESC((last.dir === 'out' ? '我：' : profileName(personProfile(last.from),last.fromName || '好友') + '：') + msgPreviewText(last))
      : '<span class="peer-group-inline">' + (g.memberCount || 1) + ' 人 · 在线 ' + (g.onlineCount || 0) + '</span>';
    return `
    <div class="peer group ${current===g.id?'active':''}" data-id="${escAttr(g.id)}" role="button" tabindex="0" aria-pressed="${current===g.id}">
      <div class="avatar-wrap">
        <div class="avatar">${avatarImage(g.avatarKey,true)}</div>
        <span class="dot ${g.onlineCount?'on':''}"></span>
      </div>
      <div class="peer-main">
        <div class="peer-row1">
          <span class="peer-name">${ESC(g.name||'群聊')}<span class="g-tag">群</span></span>
          <span class="peer-time">${last?fmtDay(last.time):''}</span>
        </div>
        <div class="peer-msg">${preview}</div>
      </div>
      ${n?`<span class="badge">${n>99?'99+':n}</span>`:''}
    </div>`;
  };

  // 置顶 + 分组
  const pinned = peers.filter(p => p.pinned);
  const normal = peers.filter(p => !p.pinned);
  const groupsMap = Object.create(null);
  for(const p of normal) (groupsMap[p.group || '我的好友'] = groupsMap[p.group || '我的好友'] || []).push(p);

  const CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  let html = '';
  if(groups.length){
    const fold = collapsedGroups.__groups ? 'folded' : '';
    html += `<button type="button" class="group-head ${fold}" aria-expanded="${!fold}" data-group="__groups">${CHEV}<span>群聊</span><i>${groups.length}</i></button>`;
    html += `<div class="group-body ${fold}">${groups.map(groupRowHTML).join('')}</div>`;
  }
  if(pinned.length){
    const fold = collapsedGroups.__pin ? 'folded' : '';
    html += `<button type="button" class="group-head ${fold}" aria-expanded="${!fold}" data-group="__pin">${CHEV}<span>置顶好友</span><i>${pinned.length}</i></button>`;
    html += `<div class="group-body ${fold}">${pinned.map(rowHTML).join('')}</div>`;
  }
  for(const [g, arr] of Object.entries(groupsMap)){
    const fold = collapsedGroups[g] ? 'folded' : '';
    html += `<button type="button" class="group-head ${fold}" aria-expanded="${!fold}" data-group="${escAttr(g)}">${CHEV}<span>${ESC(g)}</span><i>${arr.length}</i></button>`;
    html += `<div class="group-body ${fold}">${arr.map(rowHTML).join('')}</div>`;
  }
  if(!setPeerList(html)) return;
  box.querySelectorAll('.peer').forEach(el => {
    el.onclick = () => selectPeer(el.dataset.id);
    el.onkeydown = e => {
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); selectPeer(el.dataset.id); }
    };
  });
  box.querySelectorAll('[data-avatar]').forEach(el => el.ondblclick = e => {
    e.stopPropagation(); openEditPeer(el.dataset.avatar);
  });
  box.querySelectorAll('.group-head').forEach(el => el.onclick = () => {
    const g = el.dataset.group;
    collapsedGroups[g] = !collapsedGroups[g];
    renderPeers();
  });
}

let peerListMarkup = '';
function setPeerList(html){
  if(html === peerListMarkup) return false;
  peerListMarkup = html;
  const box = $('peerList'), active = document.activeElement;
  const key = box.contains(active) && (active.dataset.id ?? active.dataset.group);
  const keep = box.scrollTop;
  box.innerHTML = html;
  box.scrollTop = keep;
  if(typeof key === 'string'){
    const next = Array.from(box.querySelectorAll('[data-id],[data-group]'))
      .find(el => (el.dataset.id ?? el.dataset.group) === key);
    if(next) next.focus({preventScroll:true});
  }
  return true;
}
function renderHeader(){
  const p = convOf(current);
  const transfers = surface === 'transfers', activities = surface === 'activities';
  const app = $('app'), targetView = surface === 'chats' ? (p ? 'conversation' : 'workspace') : surface;
  const changed = !!app.dataset.view && app.dataset.view !== targetView;
  app.dataset.view = targetView;
  $('transferView').classList.toggle('hidden', !transfers);
  $('activityView').classList.toggle('hidden', !activities);
  $('emptyState').classList.toggle('hidden', surface !== 'chats' || !!p);
  $('chatPane').classList.toggle('hidden', surface !== 'chats' || !p);
  if(activities) updateActivityContext();
  if(changed && !reducedMotion()){
    const pane = $(activities ? 'activityView' : transfers ? 'transferView' : (p ? 'chatPane' : 'emptyState'));
    pane._viewAnimation?.cancel();
    pane._viewAnimation = pane.animate([
      {opacity:.55,transform:'translateY(4px)'},
      {opacity:1,transform:'none'}
    ],{duration:215,easing:'cubic-bezier(.16,1,.3,1)'});
  }
  for(const [id, section] of [['navChats','chats'], ['navTransfers','transfers'], ['navGames','activities']]){
    if(surface === section) $(id).setAttribute('aria-current','page');
    else $(id).removeAttribute('aria-current');
  }
  if(!p) return;
  const grp = isGroupConv(current);
  if(grp){
    $('chatTitle').textContent = p.name || '群聊';
    $('chatSub').innerHTML = `<span class="live ${p.onlineCount ? 'on' : ''}"></span>` +
      `<span>群聊</span><span class="sep">·</span><span>${p.memberCount || 1} 人</span>` +
      `<span class="sep">·</span><span>在线 ${p.onlineCount || 0}</span>`;
  } else {
    $('chatTitle').textContent = p.displayName + (p.mute ? '  🔇' : '');
    const bits = [];
    if(p.alias) bits.push(ESC(p.name || ''));
    bits.push(ESC(p.ip + ':' + p.http));
    if(p.platform) bits.push(ESC(p.platform));
    $('chatSub').innerHTML = `<span class="live ${p.online ? 'on' : ''}"></span>` +
      `<span>${p.online ? '在线' : '离线'}</span>` +
      bits.filter(Boolean).map(b => '<span class="sep">·</span><span>' + b + '</span>').join('');
  }
  syncAvatar($('chatAvatar'), p.avatarKey, grp);
  const details = grp ? '群资料' : '好友资料';
  $('btnEditPeer').title = details;
  $('btnEditPeer').setAttribute('aria-label', details);
}

const dismissedTransfers = new Set();
const activeTransfer = t => ['running','pausing','verifying','canceling'].includes(t.status);
const finishedTransfer = t => ['done','canceled'].includes(t.status);
function allTasks(){
  const priority = {running:0,pausing:0,verifying:0,canceling:0,paused:1,error:1,waiting:1,cancel_wait:1};
  return S.transfers.filter(t => !dismissedTransfers.has(t.id))
    .sort((a,b) => (priority[a.status] ?? 2) - (priority[b.status] ?? 2) || (b.start||0)-(a.start||0));
}

/* 传输列表：结构不变时只就地更新进度数字，避免每帧重建导致的闪烁与进度条回跳 */
let tSig = '';
const seenT = new Set();
function tStatusText(t){
  const labels = {
    pausing:'正在暂停', paused:t.direction === 'in' ? '对方已暂停' : '已暂停',
    verifying:'正在校验', waiting:'等待对方继续', error:'已中断',
    canceling:'正在取消', cancel_wait:'等待接收端清理', canceled:'已取消', done:'已完成'
  };
  if(t.status === 'running') return t.speed ? fmtSpeed(t.speed) : (t.direction === 'in' ? '接收中' : '传输中');
  return labels[t.status] || '等待确认';
}
function tMetaText(t){
  if(t.status === 'canceled') return fmtSize(t.size) + ' · 未完成数据已清理';
  return fmtSize(t.doneBytes) + ' / ' + fmtSize(t.size) +
    (t.kind === 'folder' && t.fileCount ? ' · ' + (t.filesDone || 0) + '/' + t.fileCount + ' 个文件' : '');
}
function taskActions(t, buttonClass = 'btn', diagnostics = false){
  if(t.direction !== 'out') return '';
  const button = (action, label, extra = '') => `<button type="button" class="${buttonClass} ${extra}"
    data-transfer-command="${action}" data-transfer-id="${escAttr(t.id)}">${label}</button>`;
  let html = '';
  if(t.status === 'running' && t.control) html += button('pause', '暂停');
  if(t.status === 'paused') html += button('retry', '继续');
  if(t.status === 'error' && (t.retryable || retryActions.has(t.id))) html += button('retry', t.retryable ? '重试' : '重新发送');
  if(t.status === 'cancel_wait') html += button('cancel', '重试清理');
  if(t.control && ['running','error','paused'].includes(t.status)) html += button('cancel', '取消', 'transfer-cancel');
  if(diagnostics && ['error','cancel_wait'].includes(t.status) && S.peers.some(peer => peer.id === t.peerId)){
    html += `<button type="button" class="${buttonClass}" data-task-diagnose="${escAttr(t.peerId)}">诊断</button>`;
  }
  return html;
}
const showTaskProgress = t => ['running','pausing','paused','verifying','waiting'].includes(t.status);
const taskPct = t => t.status === 'verifying' || t.status === 'done' ? 100 : pct(t);
function tItemHTML(t){
  const p = taskPct(t), isFolder = t.kind === 'folder';
  const fresh = seenT.has(t.id) ? '' : ' is-new';
  seenT.add(t.id);
  const actions = taskActions(t, 'btn', true);
  const note = t.error || (t.status === 'pausing' ? '会在当前分块结束后暂停。' : '');
  return `<div class="t-item ${escAttr(t.status)}${fresh}" data-id="${escAttr(t.id)}">
      <div class="t-row1">
        <span class="t-icon ${escAttr(t.direction)}">${t.direction === 'out' ? '↑' : '↓'}</span>
        <span class="t-name" title="${escAttr(t.name)}">${isFolder ? '📁 ' : ''}${ESC(t.name)}</span>
        <span class="t-pct">${showTaskProgress(t) ? p + '%' : (t.status === 'done' ? '✓' : (t.status === 'canceled' ? '—' : '!'))}</span>
      </div>
      ${showTaskProgress(t) ? `<div class="progress"><i style="width:${p}%"></i></div>` : ''}
      <div class="t-meta">
        <span>${tMetaText(t)}</span>
        <span class="${escAttr(t.status)}">${tStatusText(t)}</span>
      </div>
      ${actions || note ? `<div class="t-error"><span>${ESC(note)}</span>${actions}</div>` : ''}
    </div>`;
}
function updateTItem(box, t){
  const key = (window.CSS && CSS.escape) ? CSS.escape(t.id) : t.id;
  const el = box.querySelector('.t-item[data-id="' + key + '"]');
  if(!el) return;
  const p = taskPct(t);
  const bar = el.querySelector('.progress > i');
  if(bar) bar.style.width = p + '%';
  const pctEl = el.querySelector('.t-pct');
  if(pctEl && showTaskProgress(t)) pctEl.textContent = p + '%';
  const meta = el.querySelector('.t-meta');
  if(meta){
    const a = meta.querySelector('span:first-child'), b = meta.querySelector('span:last-child');
    if(a) a.textContent = tMetaText(t);
    if(b) b.textContent = tStatusText(t);
  }
}
function renderTransfers(){
  const list = allTasks();
  const box = $('transferList');
  const active = list.filter(activeTransfer).length;
  const summary = active ? (active + ' 项传输中 · 共 ' + list.length + ' 项') :
    list.length ? (list.length + ' 项记录') : '暂无传输任务';
  if($('transferCount').textContent !== summary) $('transferCount').textContent = summary;
  $('railTransferDot').hidden = active === 0;
  $('btnClearDone').classList.toggle('hidden', !list.some(finishedTransfer));
  if(!list.length){
    if(box.dataset.empty !== '1'){ box.innerHTML = '<div class="t-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 8h14m-4.5-4 4 4-4 4m5.5 4h-14m4.5-4-4 4 4 4"/></svg><p>发送或接收文件后，记录会显示在这里。</p></div>'; box.dataset.empty = '1'; }
    tSig = '';
    return;
  }
  box.dataset.empty = '0';
  const keep = box.scrollTop;
  const sig = list.map(t => [t.id, t.status, t.kind, t.name, t.size,
                             t.fileCount || 0, t.direction, t.error, t.retryable, t.control, retryActions.has(t.id)].join('~')).join('|');
  if(sig !== tSig){
    tSig = sig;
    box.innerHTML = list.map(tItemHTML).join('');
    box.scrollTop = keep;
  } else {
    list.forEach(t => updateTItem(box, t));
  }
}

function findTask(m){
  if(m.msgId) return S.transfers.find(t => t.msgId === m.msgId && t.direction === 'in');
  return null;
}
function mediaURL(path){ return '/api/media?path=' + encodeURIComponent(path||''); }

/* ---------------- 消息渲染：连发折叠 / 日期分组 / 增量刷新 ---------------- */
let msgSig = '';
let seenMessages = new Set();

function dayLabel(t){
  const d = new Date(Number(t) || Date.now()), now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if(d.toDateString() === now.toDateString()) return '今天';
  if(d.toDateString() === yest.toDateString()) return '昨天';
  const y = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '年';
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return y + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + w;
}
function updateScrollPill(){
  const box = $('messages'), btn = $('scrollBottom');
  if(!box || !btn) return;
  const visible = $('chatSearchPanel').classList.contains('hidden') && box.scrollHeight - box.scrollTop - box.clientHeight > 220;
  btn.classList.toggle('show', visible);
  btn.tabIndex = visible ? 0 : -1;
}
function scrollMessagesToBottom(smooth){
  const box = $('messages');
  if(!box) return;
  try{ box.scrollTo({ top: box.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' }); }
  catch(e){ box.scrollTop = box.scrollHeight; }
}

/* 进度条就地更新：不再为每一帧进度重建整个消息列表 */
function updateBubbleProgress(mid, p){
  if(!mid) return;
  const box = $('messages');
  if(!box) return;
  const key = (window.CSS && CSS.escape) ? CSS.escape(mid) : mid;
  const bar = box.querySelector('.bubble[data-mid="' + key + '"] .progress > i');
  if(bar) bar.style.width = Math.max(0, Math.min(100, Number(p) || 0)) + '%';
}

function renderMessages(force){
  if(!current || surface !== 'chats') return;
  const box = $('messages');
  const base = (S.messages[current] || []).slice();
  const pend = (pendingMap[current] || []).slice();
  const stored = new Set(base.map(m => m.msgId));
  for(const t of S.transfers){
    if(!t.retryable || t.direction !== 'out' || t.peerId !== current || finishedTransfer(t) || stored.has(t.msgId)) continue;
    pend.push({msgId:t.msgId, dir:'out', type:t.kind, fileName:t.name, size:t.size, time:t.time,
      status:t.status === 'error' ? 'failed' : t.status, progress:taskPct(t), retryId:t.id, error:t.error, transferControl:t.control});
  }
  const list = base.concat(pend).sort((a,b) => (a.time||0)-(b.time||0));
  const p = convOf(current) || {};
  const inGroup = isGroupConv(current);
  const mine = S.me || {};

  // 结构签名：文字/状态/文件变化才重建；进度由 updateBubbleProgress 单独补
  const members = new Map(inGroup ? list.filter(m => m.from).map(m => [m.from,personProfile(m.from)]) : []);
  const profileSig = [mine.avatarKey,mine.name,p.avatarKey,p.displayName,p.name,
    ...Array.from(members,([id,person]) => [id,person?.avatarKey,profileName(person)])];
  const sig = JSON.stringify(profileSig) + current + '#' + list.map(m => [m.msgId, m.dir, m.type, m.status || '',
      m.fileName || '', m.size || 0, (m.text || '').slice(0, 80), m.time || 0,
      m.media || '', m.error || '', m.transferControl || false, m.reply ? (m.reply.name || '') + '|' + (m.reply.text || '') : ''
    ].join('~')).join('|');

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if(!force && sig === msgSig){ updateScrollPill(); return; }

  const previousIds = msgSig && !force ? seenMessages : null;
  const keep = box.scrollTop;
  const stick = nearBottom || !msgSig;
  msgSig = sig;
  seenMessages = new Set(list.map(m => m.msgId));

  if(!list.length){
    box.innerHTML = '<div class="chat-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11a8 8 0 0 1-8 8H4l1.5-3.5A8 8 0 1 1 21 11Z"/><path d="M8 11h8"/></svg><strong>还没有消息</strong><span>发条消息，或把文件拖进这里。</span></div>';
    updateScrollPill();
    return;
  }

  // 连续的「撤回」合并成一条，避免刷屏
  const items = [];
  for(const m of list){
    const prev = items[items.length - 1];
    if(m.type === 'recalled' && prev && prev.type === 'recalled' && prev.dir === m.dir){
      prev._n = (prev._n || 1) + 1;
      prev.time = m.time;
      continue;
    }
    items.push(Object.assign({}, m, { _n: 0 }));
  }

  let html = '', lastDay = '', prevItem = null;

  items.forEach(m => {
    const t = Number(m.time) || Date.now();
    const day = new Date(t).toDateString();
    if(day !== lastDay){
      html += `<div class="day"><span>${dayLabel(t)}</span></div>`;
      lastDay = day;
      prevItem = null;
    }
    const out = m.dir === 'out';

    const author = out ? mine : inGroup ? members.get(m.from) : p;
    const authorName = profileName(author,out ? '我' : m.fromName || '好友');
    if(m.type === 'recalled'){
      const who = out ? '你' : ESC(authorName);
      html += `<div class="recalled">${who} 撤回了一条消息${
        m._n > 1 ? '（' + m._n + ' 条）' : ''}</div>`;
      prevItem = null;
      return;
    }

    const chain = !!(prevItem && prevItem.dir === m.dir &&
      (out || !inGroup || (m.from && prevItem.from === m.from)) &&
      (t - (Number(prevItem.time) || 0)) < 180000);
    const senderName = !out && inGroup && !chain ? authorName : '';
    const senderAvatar = author?.avatarKey || m.fromAvatarKey;
    let inner = '';
    const quote = m.reply
      ? `<div class="quote"><b>${ESC(m.reply.name || '')}</b>${ESC(m.reply.text || '')}</div>` : '';
    const canRecall = out && m.msgId && (Date.now() - t) < RECALL_MS && m.status !== 'failed';
    const acts = `<div class="msg-acts">
        <button data-reply="${escAttr(m.msgId)}" data-rname="${escAttr(authorName)}"
          data-rtext="${escAttr(msgPreviewText(m))}">回复</button>
        ${(m.type === 'text') ? `<button data-copy="${escAttr(m.text || '')}">复制</button>` : ''}
        ${canRecall ? `<button data-recall="${escAttr(m.msgId)}">撤回</button>` : ''}
      </div>`;

    if(m.type === 'image' && !m.retryId){
      const src = m.media ? mediaURL(m.media) : '';
      inner = `<div class="bubble image" data-mid="${escAttr(m.msgId)}">${quote}${
        src ? `<button type="button" data-view="${escAttr(src)}" aria-label="查看图片 ${escAttr(m.fileName || '')}"><img src="${escAttr(src)}" alt="${escAttr(m.fileName || '图片')}"></button>`
            : '<div class="bubble plain">图片准备中…</div>'}</div>`;
    } else if(m.type === 'folder'){
      const task = findTask(m);
      const running = (m.status === 'sending' && m.progress !== undefined) ||
                      (task && task.status === 'running');
      const pr = m.progress !== undefined ? m.progress : (task ? pct(task) : 100);
      const acts2 = (m.dir === 'in' && m.folderPath)
        ? `<div class="file-acts"><button class="file-link as-openfolder" data-folder="${escAttr(m.folderPath)}">打开文件夹</button></div>`
        : '';
      inner = `<div class="bubble plain file-bubble" data-mid="${escAttr(m.msgId)}">${quote}<div class="file-card">
          <div class="file-ico folder">📁</div>
          <div class="file-info">
            <div class="file-name" title="${escAttr(m.fileName)}">${ESC(m.fileName || '文件夹')}</div>
            <div class="file-meta">${m.fileCount || ''} 个文件 · ${fmtSize(m.size)} · ${running ? '传输中' : '已送达'}</div>
            ${running ? `<div class="progress"><i style="width:${pr}%"></i></div>` : ''}
            ${acts2}
          </div></div></div>`;
    } else if(m.type === 'file' || m.retryId){
      const task = m.retryId ? S.transfers.find(t => t.id === m.retryId) : findTask(m);
      const running = m.retryId && task ? showTaskProgress(task) : (m.status === 'sending' && m.progress !== undefined) || (task && task.status === 'running');
      const pr = m.progress !== undefined ? m.progress : (task ? pct(task) : 100);
      const ext = (m.fileName || '').split('.').pop().slice(0, 4).toUpperCase() || 'FILE';
      const controls = m.retryId && task ? taskActions(task, 'file-link') : '';
      const fileActs = m.dir === 'in' && m.media ? `
          <div class="file-acts">
            <a class="file-link" href="${escAttr('/api/download?path=' + encodeURIComponent(m.media))}">下载</a>
            <button class="file-link as-save" data-save="${escAttr(m.media)}" data-name="${escAttr(m.fileName || '')}">另存为</button>
            <button class="file-link as-open" data-open="${escAttr(m.media)}">所在文件夹</button>
          </div>`
        : (m.media ? `<a class="file-link" href="${escAttr('/api/download?path=' + encodeURIComponent(m.media))}">下载</a>` : '');
      inner = `<div class="bubble plain file-bubble" data-mid="${escAttr(m.msgId)}">${quote}<div class="file-card">
          <div class="file-ico">${ESC(ext)}</div>
          <div class="file-info">
            <div class="file-name" title="${escAttr(m.fileName)}">${ESC(m.fileName || '文件')}</div>
            <div class="file-meta">${fmtSize(m.size)} · ${m.retryId && task ? tStatusText(task) : (m.status === 'failed' ? '发送失败' : (running ? '传输中' : '已送达'))}</div>
            ${running ? `<div class="progress"><i style="width:${pr}%"></i></div>` : ''}
            ${fileActs}${controls ? `<div class="file-acts transfer-inline">${controls}</div>` : ''}
          </div></div></div>`;
    } else if(m.type === 'game'){
      const g = m.game || {};
      const mj = g.kind === 'majiang';
      const ownDesk = mj && out;
      inner = `<div class="bubble plain game-card">${quote}
        <div class="gc-ico">${mj ? '🀄' : '🃏'}</div>
        <div class="gc-main">
          <div class="gc-title">${mj ? '四川麻将邀请' : '斗地主邀请'}</div>
          <div class="gc-sub">${ESC(g.hostName || '好友')} 开了一桌${mj ? ' · 四人血战到底' : ' · 3 人局'}${ownDesk ? '' : '，点「加入」入座'}</div>
        </div>
        <button class="btn primary sm gc-btn" data-join="${escAttr(g.room || '')}"
          data-ip="${escAttr(g.ip || '')}" data-port="${escAttr(g.port || '')}" data-host-id="${escAttr(g.hostId || '')}"
          data-game="${mj ? 'majiang' : 'ddz'}" data-own-desk="${ownDesk ? '1' : ''}">${ownDesk ? '返回牌桌' : '加入'}</button>
      </div>`;
    } else {
      inner = `<div class="bubble plain" data-mid="${escAttr(m.msgId)}">${quote}${ESC(m.text || '')}</div>`;
    }

    const fresh = previousIds && m.msgId && !previousIds.has(m.msgId) ? ' is-new' : '';
    html += `<div class="msg-row ${out ? 'out' : ''}${chain ? ' chain' : ''}${fresh}" data-mid="${escAttr(m.msgId || '')}">
      <div class="avatar">${avatarImage(senderAvatar)}</div>
      <div class="msg-col"><div class="msg-time">${senderName ? `<b class="sender">${ESC(senderName)}</b>` : ''}${fmtTime(t)}</div>${inner}${acts}
      ${m.error || m.status === 'failed' ? `<div class="msg-fail">${ESC(m.error || '发送失败，检查对方是否在线')}</div>` : ''}</div>
    </div>`;
    prevItem = m;
  });

  box.innerHTML = html;
  box.querySelectorAll('[data-view]').forEach(btn => btn.onclick = () => {
    $('lightboxImg').src = btn.dataset.view;
    $('lightboxImg').alt = btn.querySelector('img').alt;
    openLightbox();
  });
  box.querySelectorAll('[data-reply]').forEach(b => b.onclick = () => {
    setReply({ msgId: b.dataset.reply, name: b.dataset.rname, text: b.dataset.rtext });
  });
  box.querySelectorAll('[data-transfer-command]').forEach(b => b.onclick = () => handleTransferCommand(b));
  box.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyText(b.dataset.copy));
  box.querySelectorAll('[data-recall]').forEach(b => b.onclick = () => recallMsg(b.dataset.recall));
  box.querySelectorAll('.as-save').forEach(b => b.onclick = async () => {
    const r = await API('/api/save-as', { path: b.dataset.save, name: b.dataset.name });
    if(r && r.ok) toast('已另存到：' + r.saved);
    else location.href = '/api/download?path=' + encodeURIComponent(b.dataset.save);
  });
  box.querySelectorAll('.as-open').forEach(b => b.onclick = async () => {
    const r = await API('/api/open-folder', { path: b.dataset.open });
    if(!r || !r.ok) toast('打开文件夹失败');
  });
  box.querySelectorAll('.as-openfolder').forEach(b => b.onclick = async () => {
    const r = await API('/api/open-folder', { path: b.dataset.folder });
    if(!r || !r.ok) toast('打开文件夹失败');
  });
  // 牌桌邀请：点「加入」进桌
  box.querySelectorAll('[data-join]').forEach(b => b.onclick = () => {
    const {join:room, ip, port, hostId, ownDesk} = b.dataset;
    if(b.dataset.game === 'majiang'){
      joinMahjongInvite({room, ip, port, hostId, own:ownDesk === '1'});
      return;
    }
    if(typeof gameOpen !== 'function') return toast('牌桌组件没加载');
    gameOpen(room, null, ip || '127.0.0.1', Number(port || S.me.http || 8765));
  });
  if(stick){
    scrollMessagesToBottom(false);
    // 图片是异步解码的，加载完再贴一次底，否则最后一张图会被切掉
    box.querySelectorAll('img').forEach(img => {
      if(img.complete) return;
      img.addEventListener('load', () => {
        if(img.isConnected && box.scrollHeight - box.scrollTop - box.clientHeight < 350) scrollMessagesToBottom(false);
      }, { once: true });
    });
  } else box.scrollTop = keep;
  updateScrollPill();
}

function selectPeer(id){
  surface = 'chats';
  chatScroll = null;
  saveDraft();
  if(current !== id){ closeChatSearch(); msgSig = ''; seenMessages.clear(); }
  current = id; unread[id] = 0; setReply(null);
  loadDraft(id);
  API('/api/read', { id });
  renderPeers(); renderHeader(); renderMessages(true); renderTitle();
  requestAnimationFrame(() => scrollMessagesToBottom(false));
  $('input').focus({preventScroll:true});
}

/* ---------------- 待发送草稿：拖拽 / 选择 / 截屏都只入队，不自动发送 ---------------- */
function saveDraft(){
  if(!current) return;
  draftMap[current] = { text: $('input').value, groups: drafts };
}
function loadDraft(pid){
  const d = draftMap[pid] || { text:'', groups:[] };
  $('input').value = d.text || '';
  drafts = d.groups || [];
  renderDrafts(); updateSendBtn();
}
function queueItems(items){
  if(!current){ toast('请先选择一个好友'); return; }
  const groups = groupItems(items);
  for(const g of groups){
    g.draftId = uid('d-');
    if(g.kind === 'single' && g.item && /^image\//.test(g.item.file.type)){
      try{ g.preview = URL.createObjectURL(g.item.file); }catch(e){}
    }
    drafts.push(g);
  }
  saveDraft(); renderDrafts(); updateSendBtn();
}
function removeDraft(id){
  const i = drafts.findIndex(g => g.draftId === id);
  if(i >= 0){
    const [g] = drafts.splice(i, 1);
    if(g.preview) URL.revokeObjectURL(g.preview);
  }
  saveDraft(); renderDrafts(); updateSendBtn();
}
function clearDrafts(){
  for(const g of drafts) if(g.preview) URL.revokeObjectURL(g.preview);
  drafts = [];
  saveDraft(); renderDrafts(); updateSendBtn();
}
function draftSize(g){
  return g.kind === 'folder' ? g.items.reduce((a,i) => a + i.file.size, 0)
                             : g.item.file.size;
}
const seenD = new Set();
function renderDrafts(){
  const bar = $('draftBar'), list = $('draftList');
  if(!drafts.length){ bar.classList.add('hidden'); list.innerHTML = ''; seenD.clear(); return; }
  bar.classList.remove('hidden');
  $('draftCount').textContent = `待发送 ${drafts.length} 项 · ${fmtSize(drafts.reduce((a,g)=>a+draftSize(g),0))}`;
  list.innerHTML = drafts.map((g, i) => {
    const isFolder = g.kind === 'folder';
    const name = isFolder ? g.name : g.item.name;
    const meta = isFolder ? `${g.items.length} 个文件 · ${fmtSize(draftSize(g))}` : fmtSize(draftSize(g));
    const ext = (name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    const ico = g.preview ? `<img src="${escAttr(g.preview)}" alt="">`
      : (isFolder ? '📁' : (/^image\//.test(g.item.file.type) ? '🖼' : ext));
    const fresh = seenD.has(g.draftId) ? '' : ' is-new';
    seenD.add(g.draftId);
    return `<div class="draft-chip ${g.preview?'has-img':''}${fresh}" data-id="${escAttr(g.draftId)}" style="--i:${i}">
      <div class="draft-ico">${ico}</div>
      <div class="draft-info">
        <div class="draft-name" title="${escAttr(name)}">${ESC(name)}</div>
        <div class="draft-meta">${ESC(meta)}</div>
      </div>
      <button class="draft-x" data-del="${escAttr(g.draftId)}" title="移除">×</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removeDraft(b.dataset.del));
  requestAnimationFrame(updateScrollPill);
}
function updateSendBtn(){
  const btn = $('btnSend');
  const ready = !!($('input').value.trim() || drafts.length > 0);
  btn.disabled = !ready || !!btn.classList.contains('loading');
  btn.classList.toggle('can-send', ready);
}
/* 输入框随内容长高（旧版固定 2 行，长句看不到全文） */
function autoGrow(){
  const el = $('input');
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
}

/* ---------------- 发送：文本 + 已确认的附件，一次点击统一发出 ---------------- */
let sending = false;
async function sendComposed(){
  if(!current){ toast('请先选择一个好友'); return; }
  if(sending) return;                       // 防连点：一次只处理一批
  const pid = current;
  const text = $('input').value.trim();
  const reply = replyTo;
  if(!text && !drafts.length) return;

  const groups = drafts.slice();
  const inputEl = $('input'), btn = $('btnSend');
  sending = true;
  btn.classList.add('loading');
  inputEl.value = '';
  setReply(null);
  drafts = [];
  saveDraft(); renderDrafts(); updateSendBtn();
  autoGrow();
  try{
    if(text) await (groupOf(pid) ? sendGroupText(text, reply, pid) : sendText(text, reply, pid));
    if(groups.length) await (groupOf(pid) ? sendGroupsToGroup(groups, pid) : sendGroups(groups, pid));
  }catch(e){
    // 失败别吞掉用户的内容：文字回填、附件退回待发送区
    toast('发送失败：' + ((e && e.message) || e));
    if(text && !inputEl.value){ inputEl.value = text; autoGrow(); }
    drafts = groups.concat(drafts);
  }finally{
    for(const g of groups) if(g.preview) URL.revokeObjectURL(g.preview);
    sending = false;
    btn.classList.remove('loading');
    saveDraft(); renderDrafts(); updateSendBtn();
  }
}
async function sendText(text, reply, pid){
  if(!text || !pid) return;
  const payload = { to: pid, type:'text', text, msgId:uid('m-'), time:Date.now() };
  if(reply) payload.reply = reply;
  await API('/api/send', payload);
  getState();
}

/* ---------------- 群消息：文本 / 文件 ---------------- */
async function sendGroupText(text, reply, gid){
  if(!text || !gid) return;
  const payload = { groupId: gid, type:'text', text, msgId: uid('m-'), time: Date.now() };
  if(reply) payload.reply = reply;
  const r = await API('/api/group/send', payload);
  if(!r || !r.ok) throw new Error((r && r.error) || '群成员都不在线');
  getState();
}

/* 群文件：给每个在线成员各传一份（silent，不产生单聊消息），再发一条群消息 */
async function sendFileToGroup(item, gid, reply){
  const g = groupOf(gid);
  if(!g) throw new Error('群不存在');
  const targets = (g.members || [])
    .map(id => S.peers.find(x => x.id === id))
    .filter(x => x && x.online);
  if(!targets.length) throw new Error('群成员都不在线');
  const isImage = /^image\//.test(item.file.type) ||
    /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(item.name);
  const mid = uid('m-');
  const task = { id: uid('t-'), direction:'out', peerId:gid, name:item.name, rel:item.rel,
    size:item.file.size, doneBytes:0, baseBytes:0, speed:0, status:'running',
    start:Date.now()/1000, msgId:mid, kind:isImage?'image':'file' };
  outTasks[task.id] = task;
  let media = '';
  try{ media = await cacheFile(item.name, item.file); }catch(e){}
  const bubble = { msgId:mid, dir:'out', type:isImage?'image':'file', text:'',
    fileName:item.name, size:item.file.size, media, time:Date.now(),
    status:'sending', progress:0 };
  (pendingMap[gid] = pendingMap[gid] || []).push(bubble);
  renderMessages(); renderTransfers();

  let done = 0, lastRemote = '';
  try{
    for(const peer of targets){
      task.baseBytes = done;
      lastRemote = await uploadTo(peer, item, task, () => {
        bubble.progress = pct(task);
        renderTransfers(); updateBubbleProgress(mid, pct(task));
      }, { silent: 1 });
      done += item.file.size;
      task.doneBytes = done;
      task.speed = 0;
      renderTransfers();
    }
    task.status = 'done';
    bubble.progress = 100;
    const payload = { groupId: gid, type: bubble.type, msgId: mid,
      fileName: item.name, size: item.file.size, media, peerMedia: lastRemote,
      time: bubble.time };
    if(reply) payload.reply = reply;
    const r = await API('/api/group/send', payload);
    if(!r || !r.ok) throw new Error((r && r.error) || '发送失败');
  }catch(e){
    task.status = 'error'; bubble.status = 'failed';
    throw e;
  }finally{
    const arr = pendingMap[gid] || [];
    const i = arr.findIndex(x => x.msgId === mid);
    if(i >= 0) arr.splice(i, 1);
    renderTransfers(); getState();
  }
}

async function sendGroupsToGroup(groups, gid){
  for(const gi of groups){
    if(gi.kind === 'folder'){
      toast('群里暂时只支持文件/图片，文件夹可以单聊发给好友');
      continue;
    }
    await sendFileToGroup(gi.item, gid, gi.reply);
  }
}

/* ---------------- 引用回复 / 撤回 / 复制 ---------------- */
function setReply(m){
  replyTo = m;
  const bar = $('replyBar');
  if(!m){ bar.classList.add('hidden'); return; }
  $('replyName').textContent = m.name + '：';
  $('replyText').textContent = m.text;
  bar.classList.remove('hidden');
  $('input').focus();
}

async function recallMsg(msgId){
  const r = await API('/api/recall', { id: current, msgId });
  if(!r.ok) toast(r.error || '撤回失败');
  getState();
}

function copyText(t){
  try{
    if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t);
    else {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast('已复制');
  }catch(e){ toast('复制失败'); }
}

/* ---------------- 发送文件 / 图片 / 文件夹 ---------------- */
async function cacheFileInfo(name, file){
  const r = await fetch('/api/cache?name=' + encodeURIComponent(name), {
    method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:file });
  const d = await r.json();
  if(!r.ok || !d.ok || !d.path) throw new Error(d.error || '本机文件缓存失败');
  return d;
}
async function cacheFile(name, file){ return (await cacheFileInfo(name, file)).path; }

async function retryTransfer(id, button){
  if(button) button.disabled = true;
  try{
    const run = retryActions.get(id);
    if(run){
      await run();
      retryActions.delete(id);
      dismissedTransfers.add(id);
      delete outTasks[id];
    } else {
      const response = await API('/api/transfer/retry', {id});
      if(!response.ok) throw new Error(response.error || '重试失败');
    }
    getState();
  }catch(e){ toast('重试失败：' + (e.message || e)); }
  finally{ if(button) button.disabled = false; }
}
async function setTransferCommand(id, action, button){
  button.disabled = true;
  try {
    const response = await API('/api/transfer/' + action, {id});
    if(!response.ok) throw new Error(response.error || '传输操作未确认');
    getState();
    return true;
  } catch(e) {
    toast(e.message || '传输操作失败');
    getState();
    return false;
  } finally { button.disabled = false; }
}
function handleTransferCommand(button){
  const id = button.dataset.transferId, action = button.dataset.transferCommand;
  if(action === 'retry'){ retryTransfer(id, button); return; }
  const t = S.transfers.find(item => item.id === id);
  if(!t) return;
  if(action !== 'cancel' || t.status === 'cancel_wait'){
    setTransferCommand(id, action, button);
    return;
  }
  openModal(`<h3>取消传输？</h3>
    <p class="sub"><b>${ESC(t.name)}</b> 的未完成数据将被清理，之后需要重新发送。已送达的文件和聊天记录不会被删除。</p>
    <div class="modal-actions"><button type="button" class="btn" id="keepTransfer">保留任务</button>
      <button type="button" class="btn danger" id="confirmCancelTransfer">取消传输</button></div>`);
  const confirm = $('confirmCancelTransfer');
  $('keepTransfer').onclick = () => closeModal(true);
  confirm.onclick = async () => {
    const ok = await setTransferCommand(id, 'cancel', confirm);
    if(ok && confirm.isConnected) closeModal(true);
  };
  $('keepTransfer').focus();
}
function rememberRetry(task, run){
  retryActions.set(task.id, run);
  if(!S.transfers.some(t => t.id === task.id)) S.transfers.push(task);
  renderTransfers();
}
function latestPeer(pid){
  const peer = S.peers.find(p => p.id === pid);
  if(!peer) throw new Error('好友已移除，请先重新添加');
  return peer;
}
function uploadTo(peer, item, task, onProgress, extra){
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({
      id: task.id, name: item.name, rel: item.rel, size: String(item.file.size),
      msgId: task.msgId, from: S.me.id, fromName: S.me.name,
      kind: task.kind, time: String(task.time || Date.now())
    });
    if(extra) for(const [k, v] of Object.entries(extra)) q.set(k, String(v));
    const url = `http://${peer.ip}:${peer.http}/api/file/upload?${q.toString()}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    let lastBytes = 0, lastTime = performance.now();
    const base = task.baseBytes || 0;
    xhr.upload.onprogress = e => {
      const now = performance.now(), dt = (now - lastTime)/1000;
      task.doneBytes = base + e.loaded;
      task.speed = dt > 0.08 ? (e.loaded - lastBytes)/dt : task.speed;
      if(dt > 0.08){ lastBytes = e.loaded; lastTime = now; }
      onProgress();
    };
    xhr.onload = () => {
      if(xhr.status >= 200 && xhr.status < 300){
        try{ resolve(JSON.parse(xhr.responseText).path || ''); }
        catch(e){ resolve(''); }
      } else reject(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('网络不可达'));
    xhr.onabort = () => reject(new Error('已取消'));
    xhr.send(item.file);
  });
}

async function sendOne(item, peer, pid, reply){
  const isImage = /^image\//.test(item.file.type) ||
    /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(item.name);
  if(peer.resume === true){
    try{
      const staged = await cacheFileInfo(item.name, item.file);
      const response = await API('/api/transfer/send-file', {
        peerId:pid, kind:isImage ? 'image' : 'file', name:item.name, ...staged, reply
      });
      if(!response.ok) throw new Error(response.error || '未能创建发送任务');
      getState();
    }catch(e){
      const task = {id:uid('t-'), direction:'out', peerId:pid, name:item.name, size:item.file.size,
        kind:isImage ? 'image' : 'file', doneBytes:0, status:'error', error:String(e.message || e), start:Date.now()/1000};
      outTasks[task.id] = task;
      rememberRetry(task, () => sendOne(item, latestPeer(pid), pid, reply));
      toast('发送失败：' + task.error);
    }
    return;
  }
  const mid = uid('m-'), tid = uid('t-');
  const task = { id:tid, direction:'out', peerId:pid, name:item.name, rel:item.rel,
    size:item.file.size, doneBytes:0, speed:0, status:'running',
    start:Date.now()/1000, msgId:mid, kind:isImage?'image':'file', path:'' };
  outTasks[tid] = task;

  const bubble = { msgId:mid, dir:'out', type:isImage?'image':'file', text:'',
    fileName:item.name, size:item.file.size, media:'', time:Date.now(),
    status:'sending', progress:0 };
  (pendingMap[pid] = pendingMap[pid] || []).push(bubble);

  let media = '';
  try{ media = await cacheFile(item.name, item.file); }catch(e){}
  bubble.media = media; task.path = media;
  renderMessages();

  try{
    const remotePath = await uploadTo(peer, item, task, () => {
      bubble.progress = pct(task);
      renderTransfers(); renderMessages();
    });
    task.status = 'done'; task.doneBytes = task.size; task.speed = 0;
    bubble.progress = 100;
    await API('/api/send', { to: pid, type: isImage?'image':'file', msgId:mid,
      fileName:item.name, size:item.file.size, media:media, peerMedia:remotePath,
      time: bubble.time, ...(reply ? { reply } : {}) });
  }catch(e){
    task.status = 'error'; task.error = String(e.message || e);
    bubble.status = 'failed';
    rememberRetry(task, () => sendOne(item, latestPeer(pid), pid, reply));
    toast('发送失败：' + (e.message || e));
  }finally{
    const arr = pendingMap[pid] || [];
    const i = arr.findIndex(x => x.msgId === mid);
    if(i >= 0) arr.splice(i, 1);
    renderTransfers(); getState();
  }
}

async function sendGroups(groups, pid){
  const peer = S.peers.find(p => p.id === pid);
  if(!peer){ toast('好友不存在'); return; }
  if(!peer.online) toast('对方当前离线，仍会尝试发送');
  const queue = groups.slice();
  const worker = async () => {
    while(queue.length){
      const g = queue.shift();
      if(g.kind === 'folder') await sendFolder(peer, g, pid, g.reply);
      else await sendOne(g.item, peer, pid, g.reply);
    }
  };
  await Promise.all([worker(), worker()]);
}

/* 把拖入/选中的一堆文件按顶层文件夹分组：一个文件夹 = 一条消息 */
function groupItems(items){
  const folders = new Map(), out = [];
  for(const it of items){
    const rel = (it.rel || it.name).replace(/\\/g, '/');
    const segs = rel.split('/');
    if(segs.length > 1){
      const top = segs[0];
      if(!folders.has(top)){
        const g = { kind:'folder', name: top, items: [] };
        folders.set(top, g); out.push(g);
      }
      folders.get(top).items.push(Object.assign({}, it, { rel }));
    } else {
      out.push({ kind:'single', item: Object.assign({}, it, { rel }) });
    }
  }
  return out;
}

/* 整个文件夹：一次登记任务，逐文件上传，进度按总字节累计，最后只发一条消息 */
async function sendFolder(peer, group, pid, reply){
  const total = group.items.reduce((a, i) => a + i.file.size, 0);
  const mid = uid('m-'), tid = uid('t-');
  const task = { id:tid, direction:'out', peerId:pid, name:group.name, size:total,
    doneBytes:0, baseBytes:0, speed:0, status:'running', kind:'folder',
    start:Date.now()/1000, msgId:mid, time:Date.now(), fileCount:group.items.length };
  outTasks[tid] = task;
  const bubble = { msgId:mid, dir:'out', type:'folder', text:'', fileName:group.name,
    size:total, fileCount:group.items.length, media:'', time:Date.now(),
    status:'sending', progress:0 };
  (pendingMap[pid] = pendingMap[pid] || []).push(bubble);
  renderMessages(); renderTransfers();

  let done = 0;
  try{
    for(let i = 0; i < group.items.length; i++){
      const it = group.items[i];
      task.baseBytes = done;
      await uploadTo(peer, it, task, () => {
        bubble.progress = pct(task);
        renderTransfers(); renderMessages();
      }, { folder: 1, idx: i, count: group.items.length, total });
      done += it.file.size;
      task.doneBytes = done;
      task.speed = 0;
      task.filesDone = i + 1;
      renderTransfers();
    }
    task.status = 'done'; task.doneBytes = total; bubble.progress = 100;
    await API('/api/send', { to: pid, type:'folder', msgId:mid,
      fileName: group.name, size: total, fileCount: group.items.length,
      media:'', time: bubble.time, ...(reply ? { reply } : {}) });
  }catch(e){
    task.status = 'error'; task.error = String(e.message || e);
    bubble.status = 'failed';
    rememberRetry(task, () => sendFolder(latestPeer(pid), group, pid, reply));
    toast('文件夹发送失败：' + (e.message || e));
  }finally{
    const arr = pendingMap[pid] || [];
    const k = arr.findIndex(x => x.msgId === mid);
    if(k >= 0) arr.splice(k, 1);
    renderTransfers(); getState();
  }
}

function filesToItems(files, useRel){
  return Array.from(files).map(f => ({
    file: f, name: f.name,
    rel: (useRel && f.webkitRelativePath) ? f.webkitRelativePath : f.name
  }));
}
function readEntry(entry, base, out){
  return new Promise(resolve => {
    if(entry.isFile){
      entry.file(f => { out.push({ file:f, name:f.name, rel:base + f.name }); resolve(); },
                 () => resolve());
    } else if(entry.isDirectory){
      const reader = entry.createReader(), all = [];
      const step = () => reader.readEntries(list => {
        if(!list.length){ Promise.all(all.map(e => readEntry(e, base + entry.name + '/', out))).then(resolve); }
        else { all.push(...list); step(); }
      }, () => resolve());
      step();
    }
  });
}
async function itemsFromDrop(dt){
  const out = [], jobs = [];
  const items = dt.items || [];
  for(const it of items){
    const e = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if(e) jobs.push(readEntry(e, '', out));
  }
  await Promise.all(jobs);
  if(!out.length){
    for(const f of (dt.files || [])) out.push({ file:f, name:f.name, rel:f.name });
  }
  return out;
}

/* ---------------- 截屏发送（QQ Ctrl+Alt+A 式） ---------------- */
async function openScreenshot(){
  if(!S.desktop){ toast('截屏仅在桌面版可用；浏览器模式请先截图再用图片按钮发送'); return; }
  toast('正在截屏…');
  const r = await API('/api/screenshot', {});
  if(!r || !r.ok){ toast('截屏失败：' + ((r && r.error) || '请重试')); return; }
  const src = mediaURL(r.path);
  const img = new Image();
  const ok = await new Promise(res => {
    img.onload = () => res(true);
    img.onerror = () => res(false);
    img.src = src;
  });
  if(!ok || !img.naturalWidth){ toast('截图读取失败，请重试'); return; }
  openCropModal(img, src);
}

function openCropModal(img, src){
  openModal(`<h3>截屏发送</h3>
    <p class="sub">按住鼠标在图上拖出要发送的区域；不拖 = 整屏发送。</p>
    <div class="crop-wrap"><div class="crop-box" id="cropBox">
      <img id="cropImg" src="${escAttr(src)}" alt="" draggable="false">
      <div class="crop-sel hidden" id="cropSel"></div>
    </div></div>
    <div class="crop-tip" id="cropTip">整屏 ${img.naturalWidth} × ${img.naturalHeight}</div>
    <div class="modal-actions">
      <button class="btn" id="mCancel">取消</button>
      <button class="btn" id="mFull">整屏加入</button>
      <button class="btn primary" id="mSend">加入待发送</button></div>`);
  const box = $('cropBox'), sel = $('cropSel'), tip = $('cropTip');
  let sx = 0, sy = 0, dragging = false, rect = null;
  const inside = e => {
    const r = box.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
             y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
             w: r.width, h: r.height };
  };
  box.onmousedown = e => {
    e.preventDefault();
    const p = inside(e); sx = p.x; sy = p.y; dragging = true;
    rect = { x: sx, y: sy, w: 0, h: 0 };
    sel.classList.remove('hidden');
  };
  box.onmousemove = e => {
    if(!dragging) return;
    const p = inside(e);
    rect = { x: Math.min(sx, p.x), y: Math.min(sy, p.y),
             w: Math.abs(p.x - sx), h: Math.abs(p.y - sy) };
    sel.style.left = rect.x + 'px'; sel.style.top = rect.y + 'px';
    sel.style.width = rect.w + 'px'; sel.style.height = rect.h + 'px';
    const scale = img.naturalWidth / box.getBoundingClientRect().width;
    tip.textContent = `已选 ${Math.round(rect.w*scale)} × ${Math.round(rect.h*scale)}`;
  };
  box.onmouseup = () => { dragging = false; };
  $('mCancel').onclick = closeModal;
  $('mFull').onclick = () => { rect = null; doSend(); };
  $('mSend').onclick = doSend;

  async function doSend(){
    if(!current){ toast('请先选择一个好友'); return; }
    const btn = $('mSend');
    if(btn){ btn.disabled = true; btn.textContent = '处理中…'; }
    try{
      const scale = img.naturalWidth / box.getBoundingClientRect().width;
      const c = document.createElement('canvas');
      let srcRect;
      if(rect && rect.w > 3 && rect.h > 3){
        c.width = Math.max(1, Math.round(rect.w * scale));
        c.height = Math.max(1, Math.round(rect.h * scale));
        srcRect = [rect.x*scale, rect.y*scale, rect.w*scale, rect.h*scale];
      } else {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        srcRect = [0, 0, c.width, c.height];
      }
      if(!c.width || !c.height) throw new Error('选区为空');
      c.getContext('2d').drawImage(img, srcRect[0], srcRect[1], srcRect[2], srcRect[3],
                                   0, 0, c.width, c.height);
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      if(!blob || blob.size < 100) throw new Error('生成图片失败');
      const name = '截图_' + new Date().toISOString().slice(0,19).replace(/[T:]/g,'-') + '.png';
      const file = new File([blob], name, { type:'image/png' });
      closeModal();
      queueItems([{ file, name, rel:name }]);
    }catch(e){
      toast('截图处理失败：' + (e.message || e));
      if(btn){ btn.disabled = false; btn.textContent = '加入待发送'; }
    }
  }
}

let modalBlockClose = false;         // 设置面板有未保存修改时，点遮罩不关闭
let modalReturnFocus = null;
let modalCleanup = null;             // 关闭时回滚（如主题预览）
function openModal(html, extraClass){
  const mask = $('modalMask'), m = $('modal');
  if(mask.classList.contains('hidden')) modalReturnFocus = document.activeElement;
  cancelExit(mask);
  m.className = 'modal' + (extraClass ? ' ' + extraClass : '');
  m.innerHTML = html;
  const title = m.querySelector('h3');
  if(title){ title.id = 'dialogTitle'; m.setAttribute('aria-labelledby','dialogTitle'); }
  else m.removeAttribute('aria-labelledby');
  $('app').inert = true;
  mask.classList.remove('hidden');
  m.focus({preventScroll:true});
}
function closeModal(force){
  const mask = $('modalMask');
  if(mask.classList.contains('hidden') || mask.classList.contains('closing')) return;
  if(modalBlockClose && !force){
    const st = $('setStatus');
    if(st){
      st.textContent = '有未保存的修改 — 点「保存」，或按 Esc 放弃';
      st.classList.add('dirty');
    }
    if(!reducedMotion()) $('modal').animate([
        {transform:'translateX(0)'}, {transform:'translateX(-5px)'},
        {transform:'translateX(5px)'}, {transform:'translateX(0)'}
      ], {duration:170, easing:'ease-out'});
    return;
  }
  modalBlockClose = false;
  if(modalCleanup){ try{ modalCleanup(); }catch(e){} modalCleanup = null; }
  hideSurface(mask, () => {
    const m = $('modal');
    m.className = 'modal'; m.innerHTML = '';
    $('app').inert = false;
    if(modalReturnFocus?.isConnected && $('mjFrameMask').classList.contains('hidden')) {
      modalReturnFocus.focus({preventScroll:true});
    }
    modalReturnFocus = null;
  });
}
$('modalMask').onclick = e => { if(e.target.id === 'modalMask') closeModal(false); };
// 勾选好友时整行高亮（和微信/QQ 的好友选择器一致）
document.addEventListener('change', e => {
  const row = e.target.closest && e.target.closest('.pick-row');
  if(row) row.classList.toggle('on', !!e.target.checked);
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    const panel = $('emojiPanel');
    if(panel && !panel.classList.contains('hidden')){ hideEmoji(); return; }
    if(!$('lightbox').classList.contains('hidden')){ closeLightbox(); return; }
    if(!$('modalMask').classList.contains('hidden')){ closeModal(true); return; }
    if(!$('chatSearchPanel').classList.contains('hidden')){ closeChatSearch(true); return; }
    if($('mjFrameMask').classList.contains('hidden')) setReply(null);
  } else if(e.key === 'Tab' && !$('modalMask').classList.contains('hidden')){
    const items = Array.from($('modal').querySelectorAll('button,input,textarea,a[href],[tabindex="0"]'))
      .filter(el => !el.disabled && el.getClientRects().length);
    if(!items.length){ e.preventDefault(); return; }
    const active = document.activeElement, first = items[0], last = items.at(-1);
    if((e.shiftKey && active === first) || (!e.shiftKey && active === last) || !items.includes(active)){
      e.preventDefault(); (e.shiftKey ? last : first).focus();
    }
  }
});
$('lightbox').onclick = () => closeLightbox();

function avatarPicker(name, selected, group = false, disabled = false){
  const options = group ? [{id:'group',name:'默认群头像'},...AVATAR_OPTIONS] : AVATAR_OPTIONS;
  const currentAvatar = normalizeAvatar(selected,group);
  return '<fieldset class="avatar-picker"' + (disabled ? ' disabled' : '') +
    '><legend>' + (group ? '群头像' : '选择头像') + '</legend><div class="avatar-options">' +
    options.map(a => `<label class="avatar-option">
      <input type="radio" name="${name}" value="${a.id}" ${a.id === currentAvatar ? 'checked' : ''}>
      <span class="avatar-choice">${avatarImage(a.id,group)}<span>${a.name}</span></span>
    </label>`).join('') + '</div></fieldset>';
}
function selectedAvatar(name){
  return $('modal').querySelector(`input[name="${name}"]:checked`).value;
}

/* 开关：button[role=switch]，点开关本体才切换（旧版整行 label 包 checkbox，点哪儿都变） */
const switchLabels = {
  fPin:'置顶该好友', fMute:'好友消息免打扰', fDnd:'消息免打扰',
  fSound:'提示音', fTray:'关闭窗口时最小化到托盘', fAuto:'开机自动启动'
};
function switchHTML(id, on, disabled){
  return `<button type="button" class="switch" role="switch" id="${id}" aria-label="${switchLabels[id]}"
    aria-checked="${on ? 'true' : 'false'}"${disabled ? ' disabled' : ''}></button>`;
}
function isSwitchOn(id){ const el = $(id); return !!el && el.getAttribute('aria-checked') === 'true'; }
function setSwitch(id, on){ const el = $(id); if(el) el.setAttribute('aria-checked', on ? 'true' : 'false'); }
function bindSwitches(root, onChange){
  root.querySelectorAll('.switch').forEach(b => b.onclick = () => {
    b.setAttribute('aria-checked', isSwitchOn(b.id) ? 'false' : 'true');
    if(onChange) onChange();
  });
}

function openAdd(){
  openModal(`<h3>添加好友</h3>
    <p class="sub">输入对方电脑的局域网 IP。两台电脑需在同一 WiFi / 路由器下；首次运行请允许防火墙放行。</p>
    <div class="field"><label for="fAddr">IP 地址或 IP:端口</label>
      <input id="fAddr" placeholder="例如 192.168.1.7 或 192.168.1.7:8765" autocomplete="off"></div>
    <div class="field"><div class="info-line">也可以直接编辑 <b>data/config.json</b> 里的
      <code>manual_peers</code>，或在「设置 → 好友与网络」里管理固定地址。</div></div>
    <div class="modal-actions"><button class="btn" id="mCancel">取消</button>
      <button class="btn" id="addDiagnose">检测连接</button>
      <button class="btn primary" id="mOk">添加</button></div>`);
  const root = $('modal'), field = $('fAddr'), submit = $('mOk'), diagnostic = $('addDiagnose');
  const output = document.createElement('div');
  output.className = 'diagnostic-result hidden';
  output.setAttribute('role', 'status');
  root.querySelector('.modal-actions').before(output);
  diagnostic.onclick = () => runDiagnostic({address:field.value}, output, diagnostic);
  $('mCancel').onclick = () => closeModal(true);
  const go = async () => {
    const addr = field.value.trim(); if(!addr || submit.disabled) return;
    submit.disabled = true; submit.textContent = '连接中…';
    try{
      const r = await API('/api/peer/add', { address: addr });
      toast(r.message || (r.ok ? '已添加' : '添加失败'));
      if(r.ok && submit.isConnected){ closeModal(true); getState(); }
      else if(submit.isConnected && !diagnostic.disabled) diagnostic.click();
    }catch(e){ toast('连接本机服务失败'); }
    finally{ submit.disabled = false; submit.textContent = '添加'; }
  };
  submit.onclick = go;
  field.onkeydown = e => { if(e.key === 'Enter') go(); };
  field.focus();
  return root;
}

function openEditPeer(pid){
  const p = S.peers.find(x => x.id === pid); if(!p) return;
  openModal(`<h3>编辑好友资料</h3>
    <p class="sub">像主流聊天软件一样自定义备注、头像和分组，只保存在本机。</p>
    <div class="field"><label>备注名</label><input id="fAlias" value="${escAttr(p.alias||'')}" placeholder="${escAttr(p.name)}"></div>
    <div class="peer-profile" data-live-profile="${escAttr(p.id)}"><span class="avatar sm">${avatarImage(p.avatarKey)}</span><span>头像由对方在自己的资料中设置</span></div>
    <div class="field"><label>分组</label><input id="fGroup" value="${escAttr(p.group||'')}" placeholder="如：同事 / 家里 / 设备"></div>
    <div class="field"><label>备注</label><textarea id="fNote" placeholder="可选">${ESC(p.note||'')}</textarea></div>
    <div class="field row-between">
      <span class="field-inline"><span>置顶该好友</span>${switchHTML('fPin', !!p.pinned)}</span>
      <span class="field-inline"><span>消息免打扰</span>${switchHTML('fMute', !!p.mute)}</span>
      <button class="btn danger" id="mDel">删除好友</button></div>
    <div class="field"><div class="info-line">原始昵称：${ESC(p.name)}<br>地址：${escAttr(p.ip)}:${p.http}
      &nbsp;·&nbsp;平台：${escAttr(p.platform||'未知')} &nbsp;·&nbsp; ${p.online?'在线':'离线'}
      &nbsp;·&nbsp; ${p.manual?'手动添加':'自动发现'}</div></div>
    <div class="modal-actions"><button class="btn" id="editDiagnose">连接诊断</button><button class="btn" id="mCancel">取消</button>
      <button class="btn primary" id="mSave">保存</button></div>`);
  const root = $('modal'); bindSwitches(root);
  $('mCancel').onclick = () => closeModal(true);
  $('editDiagnose').onclick = () => openDiagnostic(p);
  $('mSave').onclick = async () => {
    await API('/api/peer/edit', { id:pid, alias:$('fAlias').value,
      group:$('fGroup').value, note:$('fNote').value,
      pinned:isSwitchOn('fPin'), mute:isSwitchOn('fMute') });
    closeModal(true); getState();
  };
  $('mDel').onclick = async () => {
    if(!confirm('确定删除该好友？聊天记录会保留。')) return;
    await API('/api/peer/remove', { id:pid });
    if(current === pid) current = null;
    closeModal(true); getState();
  };
}

function segHTML(name, opts, cur){
  return `<div class="seg" data-seg="${name}">${opts.map(([v, t]) =>
    `<button type="button" data-val="${v}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}">${t}</button>`).join('')}</div>`;
}
function segValue(name){
  const on = document.querySelector(`.seg[data-seg="${name}"] button.on`);
  return on ? on.dataset.val : '';
}

function openSettings(){
  const c = S.config || {};
  const isWin = (S.platform || '') === 'Windows';
  const rawDir = c.download_dir || '';       // 只在用户真的指定过目录时才有值
  const effDir = S.downloadDir || '';        // 实际生效目录（含默认值），仅用于展示
  const mp = (c.manual_peers || []).join('\n');
  const openTheme = currentThemePref();
  const openMotion = currentMotion();

  openModal(`
    <div class="set-head">
      <div>
        <h3>设置</h3>
        <p class="set-sub">偏好保存在本机。主题和动效可即时预览。</p>
      </div>
      <button class="set-close" id="mCancel" title="关闭" aria-label="关闭">×</button>
    </div>

    <div class="set-layout">
    <nav class="set-nav" aria-label="设置分类">
      ${[['profile','我的资料'],['appearance','外观'],['receiving','接收与通知'],['network','好友与网络'],['updates','更新']]
        .map(([key,label],i) => `<button type="button" data-settings-section="${key}" aria-current="${i === 0}">${label}</button>`).join('')}
    </nav>
    <div class="set-body">
      <section id="settings-profile" class="set-group">
        <h4 class="set-title">我的资料</h4>
        <div class="set-row">
          <span class="set-text"><span class="set-label">昵称</span>
            <span class="set-hint">对方列表里看到的名字</span></span>
          <input class="set-input" aria-label="昵称" id="fName" maxlength="24" value="${escAttr(c.name || '')}">
        </div>
        ${avatarPicker('profileAvatar', S.me.avatarKey)}
        <p class="set-hint">保存后，昵称和头像会同步到局域网好友。</p>
      </section>

      <section id="settings-appearance" class="set-group">
        <h4 class="set-title">外观</h4>
        <div class="set-row">
          <span class="set-text"><span class="set-label">主题</span>
            <span class="set-hint">适应不同光线，或跟随系统</span></span>
          ${segHTML('theme', [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']], openTheme)}
        </div>
        <div class="set-row">
          <span class="set-text"><span class="set-label">动效</span>
            <span class="set-hint">精简动效取消位移；系统减少动态效果时也会生效</span></span>
          ${segHTML('motion', [['full', '完整'], ['reduced', '精简']], openMotion)}
        </div>
      </section>

      <section id="settings-receiving" class="set-group">
        <h4 class="set-title">接收与通知</h4>
        <div class="set-row col">
          <span class="set-text"><span class="set-label">保存位置</span>
            <span class="set-hint">当前生效：${escAttr(effDir)}</span></span>
          <div class="path-row">
            <input class="set-input" aria-label="接收文件保存位置" id="fDir" value="${escAttr(rawDir)}" placeholder="留空 = 默认 data/downloads">
            <button class="btn sm" id="mPick">更改</button>
            <button class="btn sm" id="mOpenDir">打开</button>
            <button class="btn sm" id="mResetDir" title="清空自定义目录">默认</button>
          </div>
        </div>
        <div class="set-row">
          <span class="set-text"><span class="set-label">消息免打扰</span>
            <span class="set-hint">不弹消息卡片、不响提示音</span></span>
          ${switchHTML('fDnd', !!c.dnd)}
        </div>
        <div class="set-row">
          <span class="set-text"><span class="set-label">提示音</span>
            <span class="set-hint">收到新消息时轻响一声</span></span>
          ${switchHTML('fSound', c.sound !== false)}
        </div>
        <div class="set-row">
          <span class="set-text"><span class="set-label">关闭窗口时最小化到托盘</span>
            <span class="set-hint">程序继续在后台接收文件</span></span>
          ${switchHTML('fTray', c.close_to_tray !== false)}
        </div>
        ${isWin ? `<div class="set-row">
          <span class="set-text"><span class="set-label">开机自动启动</span>
            <span class="set-hint">静默进入托盘，不开窗口</span></span>
          ${switchHTML('fAuto', !!c.autostart)}
        </div>` : ''}
      </section>

      <section id="settings-network" class="set-group">
        <h4 class="set-title">好友与网络</h4>
        <div class="set-row col">
          <span class="set-text"><span class="set-label">固定好友地址</span>
            <span class="set-hint">每行一个 IP 或 IP:端口，保存后立刻尝试连接</span></span>
          <textarea class="set-input area" aria-label="固定好友地址" id="fPeers" placeholder="192.168.1.7&#10;192.168.1.8:8765">${ESC(mp)}</textarea>
        </div>
        <div class="set-meta">
          <div><b>本机</b> ${escAttr(S.me.ip || '')}:${S.me.http || ''} · ${escAttr(S.platform || '')}${S.desktop ? ' · 桌面版' : ' · 浏览器模式'}</div>
          <div><b>版本</b> v${escAttr(S.version || '')} · 节点 ${escAttr(String(S.me.id || '').slice(0, 10))}</div>
          <div><b>数据目录</b> ${escAttr(S.dataDir || '')}
            <button class="file-link" id="mOpenData">打开</button></div>
        </div>
      </section>

      <section id="settings-updates" class="set-group">
        <h4 class="set-title">更新</h4>
        <div class="set-row">
          <span class="set-text"><span class="set-label">当前版本</span>
            <span class="set-hint">v${escAttr(S.version || '')}${S.build ? ' · 构建 ' + escAttr(S.build) : ''}${S.frozen ? '' : ' · 源码模式'}</span></span>
          <button class="btn sm" id="mCheckUpdate">检查更新</button>
        </div>
        <div class="set-row col">
          <span class="set-text"><span class="set-label">更新源</span>
            <span class="set-hint">由开发者内置（GitHub Release），不需要设置；有新版会在这里提示</span></span>
        </div>
        <div class="upd" id="updBox">
          <div class="upd-line">
            <span class="upd-text" id="updText">点「检查更新」看看有没有新版本</span>
            <button class="btn primary sm hidden" id="updAction"></button>
          </div>
          <pre class="upd-notes hidden" id="updNotes"></pre>
          <div class="progress hidden" id="updProgress"><i style="width:0%"></i></div>
        </div>
      </section>
    </div>

    </div>

    <div class="set-foot">
      <span class="set-status" role="status" id="setStatus">没有改动</span>
      <button class="btn" id="mCancel2">取消</button>
      <button class="btn primary" id="mSave" disabled>保存</button>
    </div>`, 'settings');

  const root = $('modal');
  const settingsBody = root.querySelector('.set-body');
  const sectionButtons = Array.from(root.querySelectorAll('[data-settings-section]'));
  const sections = sectionButtons.map(b => $('settings-' + b.dataset.settingsSection));
  const highlight = index => sectionButtons.forEach((b,i) => b.setAttribute('aria-current', String(i === index)));
  sectionButtons.forEach((btn,i) => btn.onclick = () => {
    settingsBody.scrollTop = sections[i].offsetTop - sections[0].offsetTop;
    highlight(i);
  });
  settingsBody.addEventListener('scroll', () => {
    if(settingsBody.scrollTop + settingsBody.clientHeight >= settingsBody.scrollHeight - 2){
      highlight(sections.length - 1); return;
    }
    let index = 0;
    sections.forEach((section, i) => {
      if(section.offsetTop - sections[0].offsetTop <= settingsBody.scrollTop + 2) index = i;
    });
    highlight(index);
  }, {passive:true});
  let dirty = false;
  const markDirty = () => {
    if(dirty) return;
    dirty = true;
    modalBlockClose = true;
    const st = $('setStatus');
    if(st){ st.textContent = '有未保存的修改'; st.classList.add('dirty'); }
    const sv = $('mSave'); if(sv) sv.disabled = false;
  };

  root.querySelector('.avatar-picker').addEventListener('change',markDirty);
  bindSwitches(root, markDirty);
  root.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    const seg = b.closest('.seg');
    if(b.classList.contains('on')) return;
    seg.querySelectorAll('button').forEach(x => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    if(seg.dataset.seg === 'theme') applyTheme(b.dataset.val);
    if(seg.dataset.seg === 'motion') applyMotion(b.dataset.val);
    markDirty();
  });
  root.querySelectorAll('input, textarea').forEach(el => {
    el.addEventListener('input', markDirty);
    if(el.tagName === 'INPUT'){
      el.addEventListener('keydown', ev => {
        if(ev.key === 'Enter'){ ev.preventDefault(); save(); }
      });
    }
  });

  $('mPick').onclick = async () => {
    const r = await API('/api/choose-folder', {});
    if(r && r.ok && r.folder){ $('fDir').value = r.folder; markDirty(); }
    else if(r && !r.ok) toast('桌面版才支持选择文件夹，可直接粘贴路径');
  };
  $('mOpenDir').onclick = async () => {
    const target = $('fDir').value.trim() || effDir;
    const r = await API('/api/open-folder', { path: target });
    if(!r || !r.ok) toast('打开失败，检查路径是否存在');
  };
  $('mResetDir').onclick = () => {
    if(!$('fDir').value){ toast('已经是默认目录'); return; }
    $('fDir').value = ''; markDirty();
  };
  $('mOpenData').onclick = async () => {
    const r = await API('/api/open-folder', { path: S.dataDir });
    if(!r || !r.ok) toast('打开失败');
  };

  const discard = () => {
    applyTheme(openTheme); applyMotion(openMotion);
    modalBlockClose = false;
  };
  modalCleanup = discard;

  async function save(){
    const btn = $('mSave');
    if(!btn || btn.disabled && !dirty) return;
    btn.disabled = true;
    const st = $('setStatus');
    if(st){ st.textContent = '保存中…'; st.classList.remove('dirty'); }
    const body = {
      name: $('fName').value.trim(),
      avatarKey: selectedAvatar('profileAvatar'),
      download_dir: $('fDir').value.trim(),
      manual_peers: $('fPeers').value.split(/[\n,]/).map(x => x.trim()).filter(Boolean),
      dnd: isSwitchOn('fDnd'),
      sound: isSwitchOn('fSound'),
      close_to_tray: isSwitchOn('fTray'),
      theme: segValue('theme') || openTheme,
      motion: segValue('motion') || openMotion
    };
    if(isWin) body.autostart = isSwitchOn('fAuto');
    let r = null;
    try{ r = await API('/api/settings', body); }
    catch(e){ r = { ok: false, error: '请求失败：' + ((e && e.message) || e) }; }
    if(r && r.ok){
      dirty = false;
      modalCleanup = null;
      modalBlockClose = false;
      applyTheme(body.theme); applyMotion(body.motion);
      if(r.me) { S.me = r.me; renderAll(); }
      if(st){ st.textContent = '已保存'; st.classList.remove('dirty'); }
      toast('设置已保存');
      getState();
      setTimeout(() => closeModal(true), 240);
    } else {
      btn.disabled = false;
      const msg = (r && r.error) || '保存失败';
      if(st){ st.textContent = msg; st.classList.add('dirty'); }
      toast(msg);
    }
  }
  $('mSave').onclick = save;
  $('mCancel').onclick = () => closeModal(true);
  $('mCancel2').onclick = () => closeModal(true);

  /* ---------------- 在线更新（GitHub Release） ---------------- */
  const updBox = $('updBox'), updText = $('updText'), updAction = $('updAction'),
        updNotes = $('updNotes'), updBar = $('updProgress');
  let updState = 'idle', updInfo = null;
  const updSay = (text, tone) => {
    updText.textContent = text;
    updText.dataset.tone = tone || '';
  };
  const updClear = () => {
    updNotes.classList.add('hidden'); updNotes.textContent = '';
    updBar.classList.add('hidden'); updBar.querySelector('i').style.width = '0%';
    updAction.classList.add('hidden'); updAction.disabled = false;
  };
  const updBtn = (label, fn) => {
    updAction.textContent = label;
    updAction.classList.remove('hidden');
    updAction.disabled = false;
    updAction.onclick = fn;
    try{ updBox.scrollIntoView({ block: 'nearest' }); }catch(e){}
  };

  async function checkUpdate(force){
    if(updState === 'checking' || updState === 'downloading') return;
    updState = 'checking';
    updClear();
    updSay('正在检查更新…');
    const btn = $('mCheckUpdate');
    btn.disabled = true;
    try{
      const r = await fetch('/api/update/check' + (force ? '?force=1' : '')).then(x => x.json());
      updInfo = r;
      if(!r || !r.ok){
        updState = 'error';
        updSay((r && r.error) || '检查失败', 'bad');
        if(!String((r && r.error) || '').includes('仓库')) updBtn('重试', () => checkUpdate(true));
        return;
      }
      if(r.hasUpdate){
        updState = 'available';
        updSay(`发现新版本 v${r.latest}（当前 v${r.current}）`, 'new');
        if(r.notes){ updNotes.textContent = r.notes; updNotes.classList.remove('hidden'); }
        if(r.asset && r.asset.url) updBtn('下载更新', () => downloadUpdate(r));
        else updSay(`有 v${r.latest}，但该 Release 没带 exe 附件`, 'bad');
        $('btnSettings').classList.add('has-update');
      }else{
        updState = 'latest';
        updSay(`已是最新版本（v${r.current}）`, 'ok');
        $('btnSettings').classList.remove('has-update');
      }
    }catch(e){
      updState = 'error';
      updSay('检查失败：' + ((e && e.message) || e), 'bad');
    }finally{
      btn.disabled = false;
    }
  }

  let updResumeTimer = null;

  function updSafeInfo(){
    return { latest: (updInfo && updInfo.latest) || '', asset: (updInfo && updInfo.asset) || {} };
  }

  async function cancelDownload(){
    updAction.disabled = true;
    try{ await API('/api/update/cancel', {}); }catch(e){}
    updAction.disabled = false;
    if(updResumeTimer){ clearTimeout(updResumeTimer); updResumeTimer = null; }
    updBar.classList.add('hidden');
    updState = 'idle';
    updSay('已取消下载');
    updBtn('重新下载', () => {
      if(updInfo && updInfo.asset && updInfo.asset.url) downloadUpdate(updInfo);
      else checkUpdate(true);
    });
  }

  // 面板关掉再打开：把后台还在跑的下载接回来
  async function resumeUpdateUI(){
    let st = null;
    try{ st = await fetch('/api/update/status').then(x => x.json()); }catch(e){ return; }
    if(!st) return;
    if(st.state === 'downloading'){
      updState = 'downloading';
      updAction.classList.remove('hidden');
      updBar.classList.remove('hidden');
      const p0 = Math.max(0, Math.min(99, st.percent || 0));
      updBar.querySelector('i').style.width = p0 + '%';
      updSay('正在下载更新 · ' + p0 + '%（退出面板也会继续）');
      updBtn('取消下载', cancelDownload);
      pollUpdate(updSafeInfo());
      return;
    }
    if(st.state === 'ready'){
      updState = 'ready';
      updAction.classList.remove('hidden');
      updBar.classList.remove('hidden');
      updBar.querySelector('i').style.width = '100%';
      updSay('更新包已下载完成，重启后生效', 'ok');
      updBtn('重启并更新', applyUpdate);
      return;
    }
    if(st.state === 'error' && st.error){
      updSay('上次下载失败：' + st.error, 'bad');
      updBtn('重试', () => checkUpdate(true));
    }
  }

  async function downloadUpdate(info){
    updInfo = info;
    updState = 'downloading';
    updAction.classList.add('hidden');
    updBar.classList.remove('hidden');
    updSay(`正在下载 v${info.latest}…`);
    const r = await API('/api/update/download', {
      url: info.asset.url, name: info.asset.name, size: info.asset.size });
    if(!r || !r.ok){
      updState = 'error';
      updBar.classList.add('hidden');
      updSay((r && r.error) || '下载没起来', 'bad');
      updBtn('重试', () => downloadUpdate(info));
      return;
    }
    if(r && r.attached) updSay('已经在下载了，接着显示进度…');
    pollUpdate(info);
  }

  async function pollUpdate(info){
    if($('modal').className.indexOf('settings') < 0) return;   // 面板关了就别再轮询
    let s = null;
    try{ s = await fetch('/api/update/status').then(x => x.json()); }catch(e){}
    if(!s){ setTimeout(() => pollUpdate(info), 600); return; }
    if(s.state === 'downloading'){
      const p = Math.max(0, Math.min(99, s.percent || 0));
      updBar.querySelector('i').style.width = p + '%';
      updSay(`正在下载 v${info.latest} · ${p}%`);
      updBtn('取消下载', cancelDownload);
      updResumeTimer = setTimeout(() => pollUpdate(info), 400);
      return;
    }
    if(s.state === 'ready'){
      updBar.querySelector('i').style.width = '100%';
      updState = 'ready';
      updSay(`v${info.latest} 已下载完成，重启后生效`, 'ok');
      updBtn('重启并更新', applyUpdate);
      return;
    }
    updState = 'error';
    updBar.classList.add('hidden');
    updSay('下载失败：' + (s.error || '未知错误'), 'bad');
    updBtn('重试', () => downloadUpdate(info));
  }

  async function applyUpdate(){
    updAction.disabled = true;
    updSay('正在替换程序并重启…');
    try{
      const r = await API('/api/update/apply', {});
      if(r && r.ok) updSay('程序会自己重启，稍等一下', 'ok');
      else { updSay((r && r.error) || '更新失败', 'bad'); updAction.disabled = false; }
    }catch(e){
      updSay('更新失败：' + ((e && e.message) || e), 'bad');
      updAction.disabled = false;
    }
  }

  $('mCheckUpdate').onclick = () => checkUpdate(true);
  resumeUpdateUI();
  // 仓库地址随检查/失焦自动落库，不必非得点「保存」，所以不算未保存修改
}

/* ---------------- 群聊：建群 / 群资料 ---------------- */
function pickRow(p, checked){
  return `<label data-live-profile="${escAttr(p.id)}" class="pick-row${checked ? ' on' : ''}${p.online ? '' : ' off'}">
    <input type="checkbox" value="${escAttr(p.id)}" ${checked ? 'checked' : ''}>
    <span class="avatar sm">${avatarImage(p.avatarKey)}</span>
    <span class="pick-name" data-profile-name>${ESC(p.displayName)}</span>
    <span class="pick-sub">${p.online ? '在线' : '离线'}</span>
  </label>`;
}

function openNewGroup(){
  const rows = S.peers.length
    ? S.peers.map(p => pickRow(p, false)).join('')
    : '<div class="peer-empty">还没有好友，先把同事的 IP 加进来</div>';
  openModal(`<h3>新建群聊</h3>
    <p class="sub">勾选好友拉进群；群资料和消息只在这几台电脑之间同步，不经过服务器。</p>
    <div class="field"><label>群名称</label>
      <input id="gName" maxlength="24" placeholder="例如：设计组 / 家里 / 项目群" autocomplete="off"></div>
    <div class="field"><label>选择好友（至少 1 个）</label>
      <div class="pick-list" id="gPick">${rows}</div></div>
    <div class="modal-actions"><button class="btn" id="mCancel">取消</button>
      <button class="btn primary" id="mCreate">创建群聊</button></div>`);
  $('mCancel').onclick = () => closeModal(true);
  $('mCreate').onclick = async () => {
    const members = Array.from(document.querySelectorAll('#gPick input:checked')).map(i => i.value);
    const name = $('gName').value.trim();
    if(!members.length){ toast('至少选一个好友'); return; }
    const btn = $('mCreate');
    btn.disabled = true; btn.textContent = '创建中…';
    const r = await API('/api/group/create', { name, members });
    btn.disabled = false; btn.textContent = '创建群聊';
    if(r && r.ok){
      closeModal(true);
      await getState();
      selectPeer(r.group.id);
      toast(`群「${r.group.name}」建好了` + (r.failed ? `，${r.failed} 人暂时没连上` : ''));
    } else {
      toast((r && r.error) || '创建失败');
    }
  };
  $('gName').focus();
}

function memberRow(g, pid, role){
  const isMe = pid === S.me.id;
  const profile = personProfile(pid);
  const name = profileName(profile, isMe ? '我' : '好友');
  const isOwner = g.role === 'owner';
  const isAdmin = g.role === 'admin';
  const targetIsAdmin = (g.admins || []).includes(pid);
  const canRole = isOwner && !isMe && pid !== g.owner;
  const canKick = !isMe && pid !== g.owner && (isOwner || (isAdmin && !targetIsAdmin));
  return `<div class="member-row" data-live-profile="${escAttr(pid)}">
    <span class="avatar sm">${avatarImage(profile?.avatarKey)}</span>
    <span class="member-name"><span data-profile-name>${ESC(name)}</span>${isMe ? '<i class="member-me">我</i>' : ''}</span>
    ${role === 'owner' ? '<span class="role-badge owner">群主</span>'
      : role === 'admin' ? '<span class="role-badge admin">管理员</span>' : ''}
    <span class="member-acts">
      ${canRole ? `<button class="link-btn" data-role="${escAttr(pid)}" data-admin="${targetIsAdmin ? 0 : 1}">${targetIsAdmin ? '撤管理' : '设管理'}</button>` : ''}
      ${canKick ? `<button class="link-btn danger" data-kick="${escAttr(pid)}">移出</button>` : ''}
    </span>
  </div>`;
}

function openEditGroup(gid){
  const g = groupOf(gid);
  if(!g) return;
  const admins = g.admins || [];
  const others = (g.members || []).filter(m => m !== g.owner);
  // 排序：群主 → 管理员 → 普通成员
  const ordered = [g.owner,
    ...admins.filter(a => a !== g.owner),
    ...others.filter(m => !admins.includes(m))];
  const rows = ordered.map(pid => memberRow(g, pid,
    pid === g.owner ? 'owner' : (admins.includes(pid) ? 'admin' : 'member'))).join('');

  const inGroup = new Set([g.owner, ...admins, ...(g.members || [])]);
  const candidates = S.peers.filter(p => !inGroup.has(p.id));
  const canInvite = g.role === 'owner' || g.role === 'admin';
  const addList = !canInvite
    ? '<div class="peer-empty" style="padding:10px 12px">只有群主 / 管理员能拉人进群</div>'
    : (candidates.length
        ? candidates.map(p => pickRow(p, false)).join('')
        : '<div class="peer-empty" style="padding:10px 12px">好友都已经在群里了；新朋友先到左侧「+」加好友，再回来拉</div>');

  openModal(`<h3>群资料</h3>
    <p class="sub">${ESC(g.memberCount || ordered.length)} 人 · 在线 ${g.onlineCount || 0}
      · ${g.role === 'owner' ? '你是群主（可以踢人、设管理、解散）' : g.role === 'admin' ? '你是管理员（可以踢普通成员）' : '普通成员'}</p>
    <div class="field"><label>群名称</label>
      <input id="gName" maxlength="24" value="${escAttr(g.name || '')}" ${canInvite ? '' : 'disabled'}></div>
    ${avatarPicker('groupAvatar',g.avatarKey,true,!canInvite)}
    <div class="field"><label>成员（群主 → 管理员 → 成员）</label>
      <div class="member-list" id="gMembers">${rows}</div></div>
    <div class="field"><label>拉人进群</label>
      <div class="pick-list" id="gAdd">${addList}</div>
      <div class="tip">${canInvite ? '勾选好友后点「拉进群」；对方会立刻在列表里看到这个群' : '让群主把你设成管理员，才有拉人权限'}</div></div>
    <div class="modal-actions">
      ${g.role === 'owner'
        ? '<button class="btn danger" id="mDissolve">解散群聊</button>'
        : '<button class="btn danger" id="mLeave">退出群聊</button>'}
      <span style="flex:1"></span>
      ${canInvite && candidates.length ? '<button class="btn" id="mAdd">拉进群</button>' : ''}
      <button class="btn" id="mCancel">关闭</button>
      ${canInvite ? '<button class="btn primary" id="mSave">保存</button>' : ''}
    </div>`);

  const root = $('modal');
  $('mCancel').onclick = () => closeModal(true);

  root.querySelectorAll('[data-kick]').forEach(b => b.onclick = async () => {
    const pid = b.dataset.kick;
    const nm = (S.peers.find(x => x.id === pid) || {}).displayName || '该成员';
    if(!confirm(`把 ${nm} 移出群聊？`)) return;
    const r = await API('/api/group/kick', { id: gid, peerId: pid });
    if(r && r.ok){ toast('已移出'); await getState(); openEditGroup(gid); }
    else toast((r && r.error) || '操作失败');
  });

  root.querySelectorAll('[data-role]').forEach(b => b.onclick = async () => {
    const pid = b.dataset.role, admin = b.dataset.admin === '1';
    const r = await API('/api/group/setrole', { id: gid, peerId: pid, admin });
    if(r && r.ok){ toast(admin ? '已设为管理员' : '已取消管理员'); await getState(); openEditGroup(gid); }
    else toast((r && r.error) || '操作失败');
  });

  if($('mAdd')) $('mAdd').onclick = async () => {
    const chosen = Array.from(document.querySelectorAll('#gAdd input:checked')).map(i => i.value);
    if(!chosen.length){ toast('先勾选要拉的人'); return; }
    const members = Array.from(new Set([...(g.members || []), ...chosen]));
    const r = await API('/api/group/edit', {
      id: gid, name: $('gName').value.trim(), avatarKey: selectedAvatar('groupAvatar'), members });
    if(r && r.ok){ toast(`已拉进 ${chosen.length} 人`); await getState(); openEditGroup(gid); }
    else toast((r && r.error) || '拉人失败');
  };

  if($('mSave')) $('mSave').onclick = async () => {
    const r = await API('/api/group/edit', {
      id: gid, name: $('gName').value.trim(), avatarKey: selectedAvatar('groupAvatar'), members: g.members || [] });
    if(r && r.ok){ closeModal(true); getState(); toast('群资料已更新'); }
    else toast((r && r.error) || '保存失败');
  };

  if($('mLeave')) $('mLeave').onclick = async () => {
    if(!confirm('退出后这个群会在本机删除，聊天记录也一起清掉。确定？')) return;
    const r = await API('/api/group/leave', { id: gid });
    if(r && r.ok){ if(current === gid) current = null; closeModal(true); getState(); toast('已退出群聊'); }
    else toast((r && r.error) || '退出失败');
  };

  if($('mDissolve')) $('mDissolve').onclick = async () => {
    if(!confirm('解散后所有成员的群里都会消失（聊天记录各自保留）。确定解散？')) return;
    const r = await API('/api/group/dissolve', { id: gid });
    if(r && r.ok){ if(current === gid) current = null; closeModal(true); getState(); toast('群已解散'); }
    else toast((r && r.error) || '解散失败');
  };
}

/* ---------------- 事件绑定 ---------------- */
$('btnAdd').onclick = $('welcomeAdd').onclick = openAdd;
function switchSurface(next){
  if(surface === next) return;
  if(surface === 'chats' && current){
    const box = $('messages');
    chatScroll = {top:box.scrollTop, bottom:box.scrollHeight - box.scrollTop - box.clientHeight < 140};
  }
  closeChatSearch();
  surface = next;
  $('dropMask').classList.add('hidden');
  renderHeader();
  if(next !== 'chats'){
    $(next === 'activities' ? 'activityHeading' : 'transferHeading').focus({preventScroll:true});
    return;
  }
  renderMessages();
  if(chatScroll){
    if(chatScroll.bottom) scrollMessagesToBottom(false);
    else $('messages').scrollTop = chatScroll.top;
    updateScrollPill();
    chatScroll = null;
  }
}
$('navTransfers').onclick = () => switchSurface('transfers');
$('navChats').onclick = () => switchSurface('chats');
$('btnNewGroup').onclick = openNewGroup;
$('btnSettings').onclick = $('meCard').onclick = openSettings;
$('btnSnap').onclick = openScreenshot;
$('btnEditPeer').onclick = () => {
  if(!current) return;
  if(isGroupConv(current)) openEditGroup(current);
  else openEditPeer(current);
};
$('btnClearChat').onclick = async () => {
  if(!current || !confirm('清空与该好友的聊天记录？')) return;
  await API('/api/clear', { id: current }); getState();
};
$('transferList').onclick = e => {
  const command = e.target.closest('[data-transfer-command]');
  if(command){ handleTransferCommand(command); return; }
  const diagnose = e.target.closest('[data-task-diagnose]');
  if(diagnose) openDiagnostic(S.peers.find(p => p.id === diagnose.dataset.taskDiagnose));
};
$('btnClearDone').onclick = async () => {
  try{
    const r = await API('/api/transfer/clear-done');
    if(!r.ok) throw new Error(r.error || '清除失败');
  }catch(e){ toast(e.message || '清除失败'); return; }
  for(const t of S.transfers){
    if(!finishedTransfer(t)) continue;
    dismissedTransfers.add(t.id);
    delete outTasks[t.id];
  }
  renderTransfers();
  $('transferHeading').focus({preventScroll:true});
};
$('btnSend').onclick = sendComposed;
$('input').onkeydown = e => {
  if(e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); sendComposed(); }
};
$('input').oninput = () => { saveDraft(); updateSendBtn(); autoGrow(); };
$('draftClear').onclick = clearDrafts;
$('peerSearch').oninput = e => { peerSearch = e.target.value; renderPeers(); };
$('peerSearch').onkeydown = e => {
  if(e.key === 'Escape'){ e.target.value = ''; peerSearch = ''; renderPeers(); e.target.blur(); }
};
$('replyCancel').onclick = () => setReply(null);
$('scrollBottom').onclick = () => scrollMessagesToBottom(true);
$('messages').addEventListener('scroll', () => updateScrollPill(), { passive: true });
window.addEventListener('resize', () => updateScrollPill());

/* ---------------- 表情（Emoji + 颜文字） ---------------- */
const EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','😏','😅','😆','😎','🥳','😴','😭','😡','🤯','🥺','😱','👍','👎','👏','🙏','💪','🤝','✌️','👌','🌹','🌸','🎂','🍎','☕','🐶','🐱','🎉','🔥','✨','❤️','💔','⚡','☀️','🌙','⭐','⚽','🎁','🏆','💡'];
const KAOS = [':)','XD','<3','^_^','T_T','0_0',';)','orz','= =','QAQ','(・∀・)','(￣▽￣)','(¬_¬)','(*´∀`)','(；′⌒`)','\\(^o^)/','(╯°□°）╯','(´･ω･`)','(๑•̀ㅂ•́)','(｡･ω･｡)'];
function buildEmojiPanel(panel){
  if(panel.dataset.ready) return;
  try{
    panel.innerHTML = `
      <div class="emoji-tabs"><button class="on" data-tab="e">Emoji</button><button data-tab="k">颜文字</button></div>
      <div class="emoji-grid" id="gridE">${EMOJIS.map(e => `<button type="button">${e}</button>`).join('')}</div>
      <div class="emoji-grid hidden" id="gridK">${KAOS.map(e => `<button type="button">${ESC(e)}</button>`).join('')}</div>`;
    const pick = b => {
      const el = $('input'); el.value += (el.value && !/\s$/.test(el.value) ? ' ' : '') + b.textContent + ' ';
      el.focus(); saveDraft(); updateSendBtn(); autoGrow();
    };
    panel.querySelectorAll('.emoji-grid button').forEach(b => b.onclick = () => pick(b));
    panel.querySelectorAll('.emoji-tabs button').forEach(b => b.onclick = () => {
      panel.querySelectorAll('.emoji-tabs button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $('gridE').classList.toggle('hidden', b.dataset.tab !== 'e');
      $('gridK').classList.toggle('hidden', b.dataset.tab !== 'k');
    });
    panel.dataset.ready = '1';
  }catch(e){ console.warn('emoji panel', e); }
}
function showEmoji(){
  const panel = $('emojiPanel');
  buildEmojiPanel(panel);
  cancelExit(panel);
  panel.classList.remove('hidden');
  const btn = $('btnEmoji');
  btn.classList.add('on'); btn.setAttribute('aria-expanded', 'true');
}
function hideEmoji(){
  const panel = $('emojiPanel');
  if(!panel || panel.classList.contains('hidden') || panel.classList.contains('closing')) return;
  hideSurface(panel);
  const btn = $('btnEmoji');
  btn.classList.remove('on'); btn.setAttribute('aria-expanded', 'false');
  if(panel.contains(document.activeElement)) btn.focus({preventScroll:true});
}
function toggleEmoji(force){
  const panel = $('emojiPanel');
  const showing = !panel.classList.contains('hidden') && !panel.classList.contains('closing');
  const want = (force === undefined) ? !showing : !!force;
  if(want) showEmoji(); else hideEmoji();
}
$('btnEmoji').onclick = e => { e.stopPropagation(); toggleEmoji(); };
document.addEventListener('click', e => {
  const panel = $('emojiPanel');
  if(!panel || panel.classList.contains('hidden')) return;
  if(e.target.closest('#emojiPanel') || e.target.closest('#btnEmoji')) return;
  hideEmoji();
});

/* ---------------- 图片查看器 ---------------- */
let imageReturnFocus = null;
function openLightbox(){
  const lb = $('lightbox');
  imageReturnFocus = document.activeElement;
  cancelExit(lb);
  lb.classList.remove('hidden');
  $('app').inert = true;
  $('lightboxClose').focus({preventScroll:true});
}
function closeLightbox(){
  hideSurface($('lightbox'), () => {
    $('lightboxImg').removeAttribute('src');
    $('app').inert = false;
    imageReturnFocus?.focus({preventScroll:true});
    imageReturnFocus = null;
  });
}

$('btnFile').onclick = () => $('fileInput').click();
$('btnImage').onclick = () => $('imageInput').click();
$('btnFolder').onclick = () => $('folderInput').click();
$('btnGame').onclick = $('navGames').onclick = () => switchSurface('activities');
$('fileInput').onchange = e => { queueItems(filesToItems(e.target.files, false)); e.target.value=''; };
$('imageInput').onchange = e => { queueItems(filesToItems(e.target.files, false)); e.target.value=''; };
$('folderInput').onchange = e => { queueItems(filesToItems(e.target.files, true)); e.target.value=''; };

document.addEventListener('paste', e => {
  if(e.defaultPrevented || !current || surface !== 'chats' || !convOf(current)) return;
  const target = e.target;
  const input = $('input');
  if(!$('chatPane').contains(target) && target !== document.body && target !== document.documentElement) return;
  if(target !== input && target.closest?.('input, textarea, select, [contenteditable]')) return;
  if(['modalMask','lightbox','chatSearchPanel','gameMask','mjFrameMask'].some(id =>
       !$(id).classList.contains('hidden'))) return;
  const pictures = collectClipboardImages(e.clipboardData);
  if(!pictures.length) return;
  e.preventDefault();
  queueItems(pictures);
  input.focus({preventScroll:true});
});

const chatRoot = $('chatRoot');
let dragDepth = 0;
chatRoot.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; if(current && surface === 'chats') $('dropMask').classList.remove('hidden'); });
chatRoot.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
chatRoot.addEventListener('dragleave', e => { e.preventDefault(); if(--dragDepth <= 0){ dragDepth=0; $('dropMask').classList.add('hidden'); } });
chatRoot.addEventListener('drop', async e => {
  e.preventDefault(); dragDepth = 0; $('dropMask').classList.add('hidden');
  if(surface !== 'chats' || !current){ toast('请先打开一个会话'); return; }
  const items = await itemsFromDrop(e.dataTransfer);
  if(items.length) queueItems(items);
});

/* ---------------- 桌面化：去掉网页默认右键菜单 / 图片拖出 / 蓝色焦点框 ---------------- */
document.addEventListener('contextmenu', e => {
  if(e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) return;
  e.preventDefault();
});
document.addEventListener('dragstart', e => {
  const t = e.target;
  if(t && (t.tagName === 'IMG' || t.tagName === 'A')) e.preventDefault();
});

/* ---------------- 窗口焦点上报（桌面版：决定是否弹消息卡） ---------------- */
const reportFocus = v => { if(S.desktop) API('/api/desktop', { action:'focus', value:v }).catch(()=>{}); };
window.addEventListener('focus', () => reportFocus(true));
window.addEventListener('blur', () => reportFocus(false));

/* ---------------- 启动 ---------------- */
applyTheme(currentThemePref(), false);
applyZoom(currentZoom(), false);
applyMotion(currentMotion(), false);
renderDrafts(); updateSendBtn(); autoGrow();
getState();
connectWS();
renderTitle();
setInterval(() => {
  if(!ws || ws.readyState !== WebSocket.OPEN){
    if(!ws || ws.readyState === WebSocket.CLOSED) getState();
  } else renderTitle();
}, 5000);

// #settings 深链（也方便自动化截图）：等 /api/state 回来再开，避免读到空配置把昵称存成空
if(location.hash === '#settings'){
  const tryOpen = () => {
    if(S.config && S.me && S.me.id) openSettings();
    else setTimeout(tryOpen, 200);
  };
  setTimeout(tryOpen, 250);
}

/* 开机静默检查一次更新：只在齿轮上点个小圆点，不打扰 */
setTimeout(async () => {
  try{
    if(!S.updateRepo) return;
    const r = await fetch('/api/update/check').then(x => x.json());
    if(r && r.ok && r.hasUpdate){
      const gear = $('btnSettings');
      gear.classList.add('has-update');
      gear.title = `有新版本 v${r.latest}（当前 v${r.current}）`;
    }
  }catch(e){}
}, 4000);
