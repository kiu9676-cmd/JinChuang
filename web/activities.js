/* Register activities here; the hub itself is independent of any game. */
const ACTIVITIES = Object.freeze([
  { id:'majiang', label:'四川麻将', note:'血战到底 · 单人练习 / 四人联机', symbol:'麻', open:openMahjongModes }
]);

function updateActivityContext(){
  const selected = convOf(current);
  $('activityContext').textContent = selected
    ? '邀请将发到「' + profileName(selected) + '」'
    : '单人项目可直接开始；联机前请先打开一个会话。';
}

function initActivities(){
  const cards = ACTIVITIES.map(activity => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'activity-card';
    button.dataset.activity = activity.id;
    const art = document.createElement('span');
    art.className = 'activity-symbol'; art.textContent = activity.symbol; art.setAttribute('aria-hidden','true');
    const details = document.createElement('span');
    details.className = 'activity-details';
    const name = document.createElement('strong');
    name.textContent = activity.label;
    const note = document.createElement('span');
    note.textContent = activity.note;
    const arrow = document.createElement('span');
    arrow.className = 'activity-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden','true');
    details.append(name,note); button.append(art,details,arrow);
    button.addEventListener('click', () => activity.open());
    return button;
  });
  $('activityList').replaceChildren(...cards);
}
initActivities();
