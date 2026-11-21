/* 会话内搜索及局域网连接诊断 */
'use strict';

let searchSession = null;
let searchType = 'all';
let searchLastRender = null;
const searchLabels = { text:'消息', image:'图片', file:'文件', folder:'文件夹' };
const searchText = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();

function openChatSearch(){
  if(!current || surface !== 'chats') return;
  searchSession = current;
  searchLastRender = null;
  searchType = 'all';
  $('chatSearchInput').value = '';
  $('chatSearchPanel').classList.remove('hidden');
  $('btnChatSearch').setAttribute('aria-expanded', 'true');
  $('messages').inert = true;
  $('messages').setAttribute('aria-hidden', 'true');
  renderChatSearch();
  updateScrollPill();
  $('chatSearchInput').focus();
}

function closeChatSearch(focus = false){
  if(!searchSession) return;
  searchSession = null;
  $('chatSearchPanel').classList.add('hidden');
  $('btnChatSearch').setAttribute('aria-expanded', 'false');
  $('messages').inert = false;
  $('messages').removeAttribute('aria-hidden');
  updateScrollPill();
  if(focus){
    $('btnChatSearch').focus();
    acknowledgeVisibleChat(); renderPeers(); renderTitle();
  }
}

function renderChatSearch(){
  if(!searchSession) return;
  if(searchSession !== current || surface !== 'chats'){ closeChatSearch(); return; }
  const all = S.messages[current] || [];
  const query = searchText($('chatSearchInput').value).trim();
  const previous = searchLastRender;
  if(previous && previous.rows === all && previous.query === query && previous.type === searchType) return;
  searchLastRender = { rows:all, query, type:searchType };
  $('chatSearchTypes').querySelectorAll('button').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.type === searchType)));
  const hits = all.filter(m => m.msgId && searchLabels[m.type] &&
    (searchType === 'all' || m.type === searchType) &&
    (!query || [m.text, m.fileName, m.reply?.text].some(value => searchText(value).includes(query))))
    .sort((a,b) => (b.time || 0) - (a.time || 0));
  $('chatSearchSummary').textContent = hits.length + ' 条结果';
  const results = $('chatSearchResults');
  results.innerHTML = hits.length ? hits.map(m => {
    const who = m.dir === 'out' ? profileName(S.me) : profileName(personProfile(m.from || current));
    const title = m.fileName || m.text || searchLabels[m.type];
    const date = m.time ? new Date(m.time).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
    return `<div class="chat-search-row">
      <button type="button" class="chat-search-hit" data-locate="${escAttr(m.msgId)}" title="定位到原消息">
        <span class="chat-search-kind">${ESC(searchLabels[m.type])}</span>
        <span class="chat-search-content"><strong>${ESC(title)}</strong>
          <small>${ESC(who || '会话成员')} · ${ESC(date)}${m.fileName && m.type !== 'text' ? ' · ' + fmtSize(m.size) : ''}</small></span>
      </button>
      ${m.media && m.fileName ? `<a class="chat-search-download" href="/api/download?path=${escAttr(encodeURIComponent(m.media))}" aria-label="下载 ${escAttr(m.fileName)}">下载</a>` : ''}
    </div>`;
  }).join('') : '<div class="chat-search-empty">没有符合条件的记录。试试其他关键词或类型。</div>';
  if(!previous || previous.query !== query || previous.type !== searchType) results.scrollTop = 0;
}

function diagnosticBody(r){
  const local = r.local || {};
  const fields = [
    ['本机地址', local.ip ? local.ip + ':' + local.http : ''],
    ['目标地址', r.address],
    ['对方版本', r.version],
    ['响应时间', Number.isInteger(r.latencyMs) ? r.latencyMs + ' ms' : ''],
    ['上次发现', r.lastSeen ? new Date(r.lastSeen).toLocaleString('zh-CN') : '']
  ];
  return `<strong>${ESC(r.message || '未收到诊断结果。')}</strong>
    <dl>${fields.filter(([,value]) => value).map(([label,value]) => `<dt>${label}</dt><dd>${ESC(value)}</dd>`).join('')}</dl>`;
}

async function runDiagnostic(target, output, button){
  button.disabled = true;
  output.classList.remove('hidden');
  output.dataset.state = 'pending';
  output.textContent = '正在检查连接…';
  try{
    const result = await API('/api/peer/diagnose', target);
    output.dataset.state = result.ok ? 'ok' : 'error';
    output.innerHTML = diagnosticBody(result);
  }catch(e){
    output.dataset.state = 'error';
    output.textContent = '本机近传服务没有返回诊断结果，请检查它是否正在运行。';
  }finally{ button.disabled = false; }
}

function openDiagnostic(peer){
  if(!peer) return;
  openModal(`<h3>连接诊断</h3><p class="sub">检查 <b>${ESC(peer.displayName || peer.name)}</b> 的当前地址是否能连接，以及响应的是否是这台设备。</p>
    <div class="diagnostic-result hidden" id="diagnosticResult" role="status"></div>
    <div class="modal-actions"><button class="btn" id="diagnosticClose">关闭</button><button class="btn primary" id="diagnosticRun">重新检测</button></div>`);
  const output = $('diagnosticResult'), button = $('diagnosticRun');
  $('diagnosticClose').onclick = () => closeModal(true);
  button.onclick = () => runDiagnostic({id:peer.id}, output, button);
  button.click();
}

$('btnChatSearch').onclick = () => searchSession ? closeChatSearch(true) : openChatSearch();
$('chatSearchClose').onclick = () => closeChatSearch(true);
$('chatSearchInput').oninput = renderChatSearch;
$('chatSearchTypes').onclick = e => {
  const type = e.target.closest('[data-type]')?.dataset.type;
  if(type){ searchType = type; renderChatSearch(); }
};
$('chatSearchResults').onclick = e => {
  const mid = e.target.closest('[data-locate]')?.dataset.locate;
  if(!mid) return;
  closeChatSearch();
  const row = $('messages').querySelector('.msg-row[data-mid="' + CSS.escape(mid) + '"]');
  if(!row) return;
  row.tabIndex = -1;
  row.focus({preventScroll:true});
  row.scrollIntoView({block:'center', behavior:reducedMotion() ? 'auto' : 'smooth'});
  row.classList.add('search-located');
  setTimeout(() => row.classList.remove('search-located'), 1300);
};

document.addEventListener('keydown', e => {
  if(e.isComposing || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return;
  if(!current || surface !== 'chats' || ['modalMask','lightbox','mjFrameMask','gameMask'].some(id =>
      $(id) && !$(id).classList.contains('hidden'))) return;
  e.preventDefault();
  if(searchSession) $('chatSearchInput').focus();
  else openChatSearch();
});
