/* Local illustrations. A profile carries only its preset key, never an external URL. */
const AVATAR_OPTIONS = Object.freeze([
  {id:'fox',name:'小狐狸'}, {id:'panda',name:'大熊猫'}, {id:'rabbit',name:'兔兔'},
  {id:'cat',name:'小猫'}, {id:'robot',name:'机器人'}, {id:'puppy',name:'小狗'}
]);
const AVATAR_IDS = new Set(AVATAR_OPTIONS.map(item => item.id));
function normalizeAvatar(value, group = false){
  return AVATAR_IDS.has(value) ? value : (group ? 'group' : 'fox');
}
const AVATAR_BASE = location.protocol === 'file:'
  ? new URL('./avatars/',document.currentScript.src).href : '/static/avatars/';
function avatarURL(value, group = false){
  return AVATAR_BASE + normalizeAvatar(value,group) + '.svg';
}
function avatarImage(key, group = false){
  return '<img src="' + avatarURL(key,group) + '" alt="" draggable="false">';
}
function syncAvatar(node, key, group = false){
  const url = avatarURL(key,group);
  const existing = node.firstElementChild;
  if(existing && existing.getAttribute('src') === url) return;
  node.innerHTML = avatarImage(key,group);
}
