const loginPage = document.querySelector('#loginPage');
const appShell = document.querySelector('#appShell');
const loginForm = document.querySelector('#loginForm');
const forgotModal = document.querySelector('#forgotModal');
const signupModal = document.querySelector('#signupModal');
const toast = document.querySelector('#toast');
const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.nav-item');
const sidebar = document.querySelector('#sidebar');
const LEGACY_STORAGE_KEY = 'tennis-progress-accounts-v1';
let accountsCache = {};
let saveQueue = Promise.resolve();
let currentEmail = sessionStorage.getItem('tennis-current-user') || '';
let calendarCursor = new Date();
let currentDetailMatchId = '';
let currentDayContext = '';
let editingMatchId = '';
let pendingConfirmAction = null;
let pendingPlan = null;
let motionPreviewUrl = '';
let currentAnalysisId = '';
let pendingVideoAnalysis = null;
let activeMistakeSegments = [];
let activeSegmentEnd = null;
let renamingAnalysisId = '';
let storageState = {configured:false, connected:false, backend:'sqlite'};

const titles = {
  overview: ['今天', '主页'], 'new-match': ['比赛记录', '记录新比赛'],
  analysis: ['动作实验室', '动作分析'],
  history: ['成长档案', '成长趋势'], matches: ['比赛档案', '全部比赛'],
  calendar: ['比赛安排', '比赛日历'], goals: ['训练计划', '训练目标'],
  exercises: ['从复盘到训练', '训练建议']
};

function accounts() {
  return accountsCache;
}
function renderStorageStatus(status = storageState) {
  storageState = {...storageState, ...status};
  const element = document.querySelector('#storageStatus');
  if (!element) return;
  element.classList.toggle('is-connected', Boolean(storageState.connected));
  element.classList.toggle('is-backup', Boolean(storageState.configured && !storageState.connected));
  const label = storageState.connected
    ? 'JSONBin 已同步'
    : storageState.configured ? (storageState.backend === 'sqlite-backup' ? '云端离线 · 本机已备份' : '云端连接失败 · 检查配置') : '等待连接 JSONBin';
  element.querySelector('.storage-status-copy').textContent = label;
  element.title = storageState.message || label;
}
async function refreshStorageStatus() {
  try {
    const response = await fetch('/api/storage-status', {cache:'no-store'});
    if (response.ok) renderStorageStatus(await response.json());
  } catch {}
}
function saveAccounts(data) {
  accountsCache = data;
  const snapshot = JSON.stringify(data);
  saveQueue = saveQueue.then(async () => {
    const response = await fetch('/api/accounts', {method:'PUT', headers:{'Content-Type':'application/json'}, body:snapshot});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '数据库保存失败');
    renderStorageStatus({configured:result.storage === 'jsonbin' || storageState.configured, connected:result.storage === 'jsonbin', backend:result.storage, message:result.storage === 'jsonbin' ? '已同步到 JSONBin' : storageState.message});
  }).catch(error => {
    refreshStorageStatus();
    showToast(error.message || '数据未能保存，请检查网站服务器');
  });
  return saveQueue;
}
function currentAccount() { return accounts()[currentEmail] || null; }
function updateAccount(mutator) {
  const data = accounts();
  if (!data[currentEmail]) return;
  mutator(data[currentEmail]);
  saveAccounts(data);
}
function prepareAccount() {
  const data = accounts(); const account = data[currentEmail];
  if (!account) return null;
  if (!account.matches) account.matches = [];
  if (!account.goals) account.goals = [];
  if (!account.scheduledMatches) account.scheduledMatches = [];
  if (!account.exercises) account.exercises = [];
  if (!account.analyses) account.analyses = [];
  saveAccounts(data); return account;
}
async function hashPassword(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}
function localDateValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function dateAfterDays(days) { const date=new Date(); date.setHours(12,0,0,0); date.setDate(date.getDate()+days); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function inferredGoalDate(title, date='') { return date || (/未来\s*[4四]\s*周|接下来\s*[4四]\s*周|四周内/i.test(title) ? dateAfterDays(28) : ''); }
function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {year:'numeric', month:'long', day:'numeric'}).format(new Date(`${value}T12:00:00`));
}
function showToast(message) {
  toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function setError(id, message = '') { document.querySelector(id).textContent = message; }
function openConfirm(title, message, action) {
  document.querySelector('#confirmTitle').textContent = title;
  document.querySelector('#confirmMessage').textContent = message;
  pendingConfirmAction = action;
  document.querySelector('#confirmModal').showModal();
}
function sortedMatches(matches = []) {
  return [...matches].sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));
}
function satisfactionEmoji(value) {
  if (['😔','😐','😄','🤩'].includes(value)) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return '😐';
  return number <= 3 ? '😔' : number <= 5.5 ? '😐' : number <= 8 ? '😄' : '🤩';
}
function satisfactionPercent(value) { return {'😔':25,'😐':50,'😄':75,'🤩':100}[satisfactionEmoji(value)]; }

function showView(name) {
  views.forEach(view => view.classList.toggle('active', view.id === `${name}View`));
  navItems.forEach(item => item.classList.toggle('active', item.dataset.view === name));
  const account = currentAccount();
  document.querySelector('#pageKicker').textContent = titles[name]?.[0] || '';
  document.querySelector('#pageTitle').textContent = name === 'overview' && account ? `你好，${account.name}` : titles[name]?.[1] || '';
  if (['overview','matches','history'].includes(name)) renderData();
  if (name === 'history') renderTrends();
  if (name === 'analysis') renderAnalysisHistory();
  if (name === 'calendar') renderCalendar();
  if (name === 'goals') renderGoals();
  if (name === 'exercises') renderExercises();
  sidebar.classList.remove('open'); window.scrollTo({top:0, behavior:'smooth'});
}
function openApp() {
  const account = prepareAccount(); if (!account) return;
  loginPage.hidden = true; appShell.hidden = false;
  sessionStorage.setItem('tennis-current-user', currentEmail);
  const initial = account.name.trim().charAt(0).toUpperCase() || '你';
  document.querySelector('#userAvatar').textContent = initial;
  document.querySelector('#userName').textContent = account.name;
  document.querySelector('#userEmail').textContent = account.email;
  currentAnalysisId='';document.querySelector('.motion-layout').classList.remove('has-report');document.querySelector('#analysisResult').innerHTML='<div class="analysis-empty"><span>◎</span><h2>等待一场比赛</h2><p>完成分析后，这里会显示动作窗口、身体轨迹观察和可能的改进方向。</p></div>';document.querySelector('#analysisHistory').innerHTML='';
  renderData(); renderCalendar(); renderGoals(); renderExercises(); showView('overview');
}

function scoreText(match) {
  return match.sets.map(set => `${set.player}–${set.opponent}${set.tiebreak ? ` (${set.tiebreak.player}–${set.tiebreak.opponent})` : ''}`).join(' · ');
}
function matchCard(match) {
  const note = match.note ? `<p>${escapeHtml(match.note)}</p>` : '';
  return `<button type="button" class="real-match-card" data-match-id="${escapeHtml(match.id)}">
    <div><span>${escapeHtml(formatDate(match.date))} · ${escapeHtml(match.matchType || '单打')} · ${escapeHtml(match.surface)}</span><h3>对阵 ${escapeHtml(match.opponent)}</h3></div>
    <div class="real-score"><b class="${match.result === '胜' ? 'won' : ''}">${escapeHtml(match.result)}</b><strong>${escapeHtml(scoreText(match))}</strong><span class="match-emoji">${satisfactionEmoji(match.satisfaction)}</span></div>
    ${note}<i class="card-arrow">查看详情 →</i></button>`;
}
function renderData() {
  const account = currentAccount(); if (!account) return;
  const matches = sortedMatches(account.matches); const hasMatches = matches.length > 0;
  document.querySelector('#emptyDashboard').hidden = hasMatches;
  document.querySelector('#userDashboard').hidden = !hasMatches;
  document.querySelector('#matchesEmpty').hidden = hasMatches;
  document.querySelector('#allMatches').hidden = !hasMatches;
  if (hasMatches) {
    const now = new Date(); const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}`;
    const monthMatches = matches.filter(match => match.date.startsWith(prefix));
    const monthWins = monthMatches.filter(match => match.result === '胜').length;
    document.querySelector('#totalMatches').textContent = matches.length;
    document.querySelector('#monthlyWinRate').textContent = monthMatches.length ? Math.round(monthWins / monthMatches.length * 100) : '—';
    document.querySelector('#monthlyWinRateUnit').textContent = monthMatches.length ? `% · ${monthWins}/${monthMatches.length} 场` : '本月暂无比赛';
    const chronological = [...matches].sort((a,b) => a.date.localeCompare(b.date) || Number(a.id)-Number(b.id));
    let currentStreak = 0, longestStreak = 0;
    chronological.forEach(match => { if (match.result === '胜') { currentStreak++; longestStreak = Math.max(longestStreak, currentStreak); } else currentStreak = 0; });
    document.querySelector('#longestWinStreak').textContent = longestStreak;
    document.querySelector('#averageSatisfaction').textContent = satisfactionEmoji(matches[0].satisfaction);
    document.querySelector('#dashboardGreeting').textContent = matches.length === 1 ? '你的第一场记录' : `最近 ${Math.min(matches.length, 3)} 场比赛`;
    document.querySelector('#recentMatches').innerHTML = matches.slice(0,3).map(matchCard).join('');
    document.querySelector('#allMatches').innerHTML = matches.map(matchCard).join('');
  }
  renderNextMatch();
}

function chartHtml(points, colorClass) {
  return `<div class="chart-y"><span>100%</span><span>50%</span><span>0%</span></div><div class="chart-plot">${points.map(point => `<div class="chart-column"><div class="chart-value">${point.value}%</div><div class="chart-track"><i class="${colorClass}" style="height:${point.value}%"></i></div><span>${escapeHtml(point.label)}</span></div>`).join('')}</div>`;
}
function renderTrends() {
  const matches = currentAccount()?.matches || []; const grouped = {};
  matches.forEach(match => { const key = match.date.slice(0,7); if (!grouped[key]) grouped[key] = []; grouped[key].push(match); });
  const months = Object.keys(grouped).sort().slice(-8); const empty = months.length === 0;
  document.querySelector('#trendEmpty').hidden = !empty; document.querySelector('.trend-grid').hidden = empty;
  if (empty) { document.querySelector('#historyMessage').textContent = '记录比赛后，这里会生成按月趋势。'; return; }
  const satisfaction = months.map(key => ({label:`${Number(key.slice(5))}月`, value:Math.round(grouped[key].reduce((sum,m) => sum + satisfactionPercent(m.satisfaction),0) / grouped[key].length)}));
  const wins = months.map(key => ({label:`${Number(key.slice(5))}月`, value:Math.round(grouped[key].filter(m => m.result === '胜').length / grouped[key].length * 100)}));
  document.querySelector('#satisfactionChart').innerHTML = chartHtml(satisfaction,'satisfaction-bar');
  document.querySelector('#winRateChart').innerHTML = chartHtml(wins,'win-bar');
  document.querySelector('#satisfactionTrendLatest').textContent = `${satisfaction[satisfaction.length-1].value}%`;
  document.querySelector('#winRateTrendLatest').textContent = `${wins[wins.length-1].value}%`;
  document.querySelector('#historyMessage').textContent = `基于 ${matches.length} 场真实比赛，按月汇总。`;
}

function daysUntil(date) { const today = new Date(); today.setHours(0,0,0,0); return Math.round((new Date(`${date}T00:00:00`) - today) / 86400000); }
function nextScheduledMatch() { const today = localDateValue(); return [...(currentAccount()?.scheduledMatches || [])].filter(item => item.date >= today).sort((a,b) => a.date.localeCompare(b.date))[0]; }
function countdownText(item) { if (!item) return '还没有安排下一场比赛。'; const days = daysUntil(item.date); return days === 0 ? '你的下一场比赛就是今天。' : days === 1 ? '你的下一场比赛在明天。' : `你的下一场比赛在 ${days} 天后。`; }
function renderNextMatch() {
  const next = nextScheduledMatch(); const banner = document.querySelector('#nextMatchBanner'); banner.hidden = !next; if (!next) return;
  document.querySelector('#nextMatchCountdown').textContent = countdownText(next);
  document.querySelector('#nextMatchInfo').textContent = `${formatDate(next.date)} · ${next.type} · 对阵 ${next.opponent}${next.location ? ` · ${next.location}` : ''}`;
}
function renderCalendar() {
  const account = currentAccount(); if (!account) return; const today = localDateValue();
  document.querySelector('#calendarCountdown').textContent = countdownText(nextScheduledMatch());
  document.querySelector('#calendarTitle').textContent = new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long'}).format(calendarCursor);
  const year = calendarCursor.getFullYear(), month = calendarCursor.getMonth();
  const offset = (new Date(year,month,1).getDay()+6)%7, total = new Date(year,month+1,0).getDate();
  const recorded = new Set(account.matches.map(match => match.date)), scheduled = new Set(account.scheduledMatches.map(item => item.date));
  const cells = Array.from({length:offset},() => '<span class="calendar-day empty"></span>');
  for (let day=1; day<=total; day++) { const date=`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`; const hasRecorded=recorded.has(date), hasScheduled=scheduled.has(date); const scheduledMarker=hasScheduled&&!hasRecorded?`<i class="${date<today?'recorded-dot':'scheduled-dot'}"></i>`:''; const markers=`${hasRecorded?'<i class="recorded-dot"></i>':''}${scheduledMarker}`; cells.push(`<button type="button" class="calendar-day ${date===today?'today':''}" data-calendar-date="${date}"><b>${day}</b><em>${markers}</em></button>`); }
  document.querySelector('#calendarGrid').innerHTML = cells.join('');
  const upcoming = [...account.scheduledMatches].filter(item=>item.date>=today).sort((a,b)=>a.date.localeCompare(b.date));
  document.querySelector('#upcomingMatches').innerHTML = upcoming.length ? upcoming.map(item=>`<article class="upcoming-item"><time>${formatDate(item.date)}</time><strong>对阵 ${escapeHtml(item.opponent)}</strong><span>${escapeHtml(item.type)}${item.location?` · ${escapeHtml(item.location)}`:''}</span></article>`).join('') : '<p class="calendar-empty">还没有未来比赛。点击“安排比赛”添加。</p>';
  renderNextMatch();
}

function goalHtml(goal) { return `<article class="goal-item ${goal.completed?'completed':''}"><label><input type="checkbox" data-goal-check="${goal.id}" ${goal.completed?'checked':''}/><span></span></label><div><strong>${escapeHtml(goal.title)}</strong>${goal.date?`<small>目标日期 ${formatDate(goal.date)}</small>`:'<small>未设置日期</small>'}</div><button type="button" data-goal-delete="${goal.id}" aria-label="删除目标">×</button></article>`; }
function renderGoals() {
  const goals = currentAccount()?.goals || [], active = goals.filter(g=>!g.completed), completed = goals.filter(g=>g.completed);
  document.querySelector('#activeGoalsEmpty').hidden = active.length>0; document.querySelector('#completedGoalsEmpty').hidden = completed.length>0;
  document.querySelector('#activeGoalList').innerHTML = active.map(goalHtml).join(''); document.querySelector('#completedGoalList').innerHTML = completed.map(goalHtml).join('');
  const badge=document.querySelector('#goalBadge');badge.hidden=active.length===0;badge.textContent=active.length;
  const today=new Date(`${localDateValue()}T12:00:00`);const dated=active.filter(goal=>goal.date).map(goal=>({...goal,days:Math.ceil((new Date(`${goal.date}T12:00:00`)-today)/86400000)})).sort((a,b)=>a.days-b.days);const notice=document.querySelector('#goalNotice');
  if(!dated.length){notice.hidden=true;}else{const next=dated[0];notice.hidden=false;notice.innerHTML=`<span>目标提醒</span><strong>${next.days<0?`已逾期 ${Math.abs(next.days)} 天`:next.days===0?'今天到期':`还有 ${next.days} 天`}</strong><p>${escapeHtml(next.title)}</p>`;}
}
const exerciseRules = [
  {terms:['反手失误','反手不好','反手不稳'], title:'反手稳定性：对墙连续击球 3 组 × 20 球'},
  {terms:['发球不好','发球失误','双误','二发'], title:'发球节奏：抛球练习 3 组 × 15 次，再完成 30 个二发'},
  {terms:['脚步运动','脚步','跑动','移动慢'], title:'六点步法：每组 45 秒，共 4 组，组间休息 30 秒'}
];
function generateExercises(note, matchId, account) {
  account.exercises = account.exercises.filter(item => String(item.generatedFrom) !== String(matchId));
  const generated = [];
  exerciseRules.forEach(rule => { if (rule.terms.some(term => note.includes(term))) generated.push({id:Date.now()+generated.length,title:rule.title,completed:false,generatedFrom:matchId,source:'根据赛后复盘自动推荐'}); });
  account.exercises.unshift(...generated); return generated.length;
}
function exerciseHtml(item) {
  const buttonLabel = !item.completed && item.generatedFrom ? '忽略' : '删除';
  return `<article class="exercise-item ${item.completed?'completed':''}"><label><input type="checkbox" data-exercise-check="${item.id}" ${item.completed?'checked':''}/><span></span></label><div><strong>${escapeHtml(item.title)}</strong></div><button type="button" data-exercise-delete="${item.id}">${buttonLabel}</button></article>`;
}
function renderExercises() {
  const exercises = currentAccount()?.exercises || [], active=exercises.filter(e=>!e.completed), completed=exercises.filter(e=>e.completed);
  document.querySelector('#exercisesEmpty').hidden = active.length>0; document.querySelector('#activeExerciseList').innerHTML = active.map(exerciseHtml).join('');
  document.querySelector('#completedExercisesSection').hidden = completed.length===0; document.querySelector('#completedExerciseList').innerHTML = completed.map(exerciseHtml).join('');
  const badge=document.querySelector('#exerciseBadge'); badge.hidden=active.length===0; badge.textContent=active.length;
}

const goalExerciseRules = [
  {terms:['发球','抛球','双误','二发'], exercises:['抛球落点定位 15 次 × 3 组','二发旋转练习 20 球 × 3 组']},
  {terms:['正手','forehand'], exercises:['正手斜线 20 球 × 3 组','正手进攻球 15 球 × 3 组']},
  {terms:['反手','backhand'], exercises:['反手斜线 20 球 × 3 组','反手连续对墙 30 球 × 3 组']},
  {terms:['脚步','移动','跑动'], exercises:['六点步法 45 秒 × 4 组','分腿垫步启动 12 次 × 3 组']},
  {terms:['网前','截击'], exercises:['网前截击 10 分钟','左右移动截击 12 球 × 3 组']},
  {terms:['体能','耐力'], exercises:['场边折返跑 30 秒 × 5 组','跳绳 3 分钟 × 3 组']}
];
function recommendedExercises(text) {
  const result=[];
  goalExerciseRules.forEach(rule=>{if(rule.terms.some(term=>text.toLowerCase().includes(term)))result.push(...rule.exercises);});
  return [...new Set(result.length?result:[`围绕“${text}”进行专项练习 10 次 × 3 组`])].slice(0,4);
}
function openPlanReview({goal='', date='', exercises=[], analysisId='', message=''}) {
  date=inferredGoalDate(goal,date);
  pendingPlan={goal,date,exercises,analysisId};
  document.querySelector('#planReviewTitle').textContent=analysisId?'确认这份改进计划？':'添加目标与推荐练习？';
  document.querySelector('#planReviewMessage').textContent=message||'系统根据目标内容推荐了相关练习。勾选你愿意执行的内容。';
  let html='';
  if(goal)html+=`<label class="plan-choice plan-choice--goal"><input type="checkbox" data-plan-goal checked/><span><b>训练目标</b><strong>${escapeHtml(goal)}</strong>${date?`<small>目标日期 ${formatDate(date)}</small>`:''}</span></label>`;
  html+=exercises.map((title,index)=>`<label class="plan-choice"><input type="checkbox" data-plan-exercise="${index}" checked/><span><b>训练练习</b><strong>${escapeHtml(title)}</strong></span></label>`).join('');
  document.querySelector('#planReviewList').innerHTML=html;
  document.querySelector('#planReviewModal').showModal();
}
function closePlanReview(){pendingPlan=null;document.querySelector('#planReviewModal').close();}
function analysisCheckHtml(item){const mark=item.status==='good'?'✓':item.status==='warn'?'↗':'?';const label=item.status==='good'?'动作稳定':item.status==='warn'?'可能的改进':'无法判断';return `<article class="motion-check ${item.status}"><i>${mark}</i><div><span>${label}</span><h3>${escapeHtml(item.label)}</h3><b>${escapeHtml(item.measured)}</b><p>${escapeHtml(item.feedback)}</p></div></article>`;}
function preciseCheck(item){if(item.label!=='击球点与伸展')return item;const angle=Number((item.measured.match(/\d+/)||[])[0]);if(angle&&angle<145)return{...item,label:'击球臂伸展不足',measured:`击球高点肘角约 ${angle}°；距离 145° 参考值还差 ${145-angle}°`,feedback:'截图中上臂和前臂形成明显折角。击球前把持拍手送离身体，接触时让肘部接近伸直，完成接触后再自然弯曲。'};return{...item,label:'击球点高度偏低',feedback:'截图中持拍手停在头部附近。提前完成引拍，主动把持拍手向上送，在球下降到头侧之前完成接触。'};}
function checkForFrame(frame, checks){if(frame.checkLabel){const exact=checks.find(item=>item.label===frame.checkLabel);if(exact)return exact;}const label=frame.label||'';if(label.includes('屈膝'))return checks.find(item=>item.label.includes('屈膝'));if(label.includes('肩部'))return checks.find(item=>item.label.includes('肩部'));if(label.includes('伸展'))return checks.find(item=>item.label.includes('伸展'));if(label.includes('高度')||label.includes('高点'))return checks.find(item=>item.label.includes('高度'));if(label.includes('空间'))return checks.find(item=>item.label.includes('空间'));return checks.find(item=>item.status==='warn');}
function englishMistake(segment){const label=segment.check?.label||segment.label||'';if(label.includes('转体'))return{title:'Limited visible upper-body rotation',evidence:'Across the selected high-speed movement window, the projected shoulder line changed less than the review threshold.',advice:'This may indicate a small preparation-and-release pattern from this camera angle. Try completing the shoulder and hip turn before letting the arm follow.'};if(label.includes('平衡'))return{title:'Balance may move outside the base of support',evidence:'In part of the movement window, the projected hip centre moved beyond the area supported by both feet.',advice:'Try lowering your centre of mass and hold the finish for two seconds before beginning the recovery step.'};if(label.includes('站位'))return{title:'Stance width may limit stability or recovery',evidence:'The visible ankle-to-ankle width was outside the comparison range relative to shoulder width.',advice:'Adjust toward a comfortable shoulder-width base, stay active with small steps, and recover immediately after the swing.'};if(label.includes('下肢'))return{title:'Limited visible knee flexion',evidence:'The knees remained relatively straight during the selected high-speed movement window.',advice:'Try a light knee bend during preparation, followed by a natural extension through the swing.'};if(label.includes('挥拍'))return{title:'Short visible swing path',evidence:'The racket-side wrist travelled a short distance relative to shoulder width during this movement window.',advice:'This may come from tension or late preparation. Rehearse a slow, continuous shadow swing before gradually adding speed.'};return{title:'Visible movement pattern',evidence:'This observation comes from the player’s body-keypoint path across several nearby frames.',advice:'Treat it as a possible improvement to test, not a definite diagnosis. Compare it with the replay and how the movement felt.'};}
const coachingVideo={id:'9T6ixfsb9Bc',source:'Top Tennis Training · Coach Simon Konov'};
function coachingFor(segment){
  const label=segment.check?.label||segment.label||'';
  if(label.includes('转体')||label.includes('挥拍'))return{...coachingVideo,start:530,chapter:'08:50 · 正手蓄力与挥拍位置',title:'观察转体与连贯挥拍',cue:'先完成身体准备，再让手臂跟随转动。对照整体节奏，不需要模仿固定的肘角。'};
  if(label.includes('平衡')||label.includes('站位')||label.includes('下肢'))return{...coachingVideo,start:706,chapter:'11:46 · 正手脚步与移动',title:'观察站位、平衡与恢复',cue:'重点看准备站位、移动后的稳定状态，以及挥拍结束后的恢复步。'};
  return{...coachingVideo,start:706,chapter:'11:46 · 正手脚步与移动',title:'观察完整动作节奏',cue:'对照准备、挥拍和恢复三个阶段，只比较报告中描述的身体动作模式。'};
}
function coachingCardHtml(segment,index){const coach=coachingFor(segment);return `<section class="coaching-card"><div class="coaching-copy"><span>正确动作示范 · Correct technique</span><h4>${escapeHtml(coach.title)}</h4><p>${escapeHtml(coach.cue)}</p><small>${escapeHtml(coach.source)}<br>${escapeHtml(coach.chapter)}</small></div><div class="coaching-video-slot"><button type="button" class="coaching-play" data-open-coaching="${index}" aria-label="放大并从 ${escapeHtml(coach.chapter)} 开始播放教学视频"><img src="https://i.ytimg.com/vi/${coach.id}/hqdefault.jpg" alt="${escapeHtml(coach.title)} 教学视频封面" loading="lazy"/><span><i>▶</i>放大播放重点片段</span></button></div></section>`;}
function mistakeDetailHtml(segment,index){const english=englishMistake(segment);return `<span class="error-number">可能的改进 · ${String(index+1).padStart(2,'0')} · ${segment.time.toFixed(2)} 秒</span><h3>${escapeHtml(segment.label)}</h3><b>${escapeHtml(segment.check?.measured||'动作关键帧')}</b><p>${escapeHtml(segment.check?.feedback||'请结合动作窗口回放判断这个观察是否符合你的实际感受。')}</p><div class="screenshot-actions"><button type="button" data-freeze-error="${index}">⏸ 定格到观察时刻</button><button type="button" data-open-error-image="${index}">放大动作截图</button></div><details class="english-feedback"><summary>查看英文说明 <span>English</span></summary><div><h4>${escapeHtml(english.title)}</h4><b>${escapeHtml(english.evidence)}</b><p>${escapeHtml(english.advice)}</p></div></details><div class="error-play-actions"><button type="button" data-play-error="${index}" data-rate="1">▶ 播放动作窗口</button><button type="button" data-play-error="${index}" data-rate="0.35">◷ 慢动作播放</button></div>${coachingCardHtml(segment,index)}`;}
function confidenceHtml(analysis){const confidence=Number(analysis.movementConfidence)||0;if(confidence>=80)return `<section class="confidence-status reliable"><strong>✓ 身体动作轨迹清楚</strong><p>动作轨迹清晰度 ${confidence}%。报告基于连续身体关键点，不检测网球。</p></section>`;if(confidence>=45)return `<section class="confidence-status verify"><strong>仅作为可能的改进参考</strong><p>动作轨迹清晰度 ${confidence}%。部分身体帧不连续，请结合回放和实际感受判断。</p></section>`;return `<section class="confidence-status manual"><strong>身体动作轨迹不够清楚</strong><p>动作轨迹清晰度 ${confidence}%。系统不会根据过少的身体帧生成技术建议。</p></section>`;}
function manualContactHtml(){return '';}
function renderAnalysis(analysis) {
  if(!analysis)return;
  currentAnalysisId=analysis.id;
  document.querySelector('.motion-layout').classList.add('has-report');
  if(!analysis.analysisVersion||analysis.analysisVersion<4){activeMistakeSegments=[];document.querySelector('#analysisResult').innerHTML=`<article class="analysis-report analysis-report--focus"><header><div><span class="eyebrow eyebrow--green">旧版分析已停用</span><h2>这份报告使用了网球位置检测。</h2><p>球的位置在远景比赛视频中容易识别错误，因此旧版技术结论已经隐藏。</p></div><button class="new-analysis-button" id="newAnalysisButton" type="button">使用动作轨迹重新分析</button></header><section class="outdated-analysis"><strong>新版只观察球员动作</strong><p>系统检查连续身体关键点中的转体、平衡、站位、下肢准备和挥拍轨迹，不再寻找网球或猜测触球时刻。</p></section></article>`;return;}
  const checks=(analysis.checks||[]).map(preciseCheck),good=checks.filter(item=>item.status==='good'),unknown=checks.filter(item=>item.status==='unknown');activeMistakeSegments=(analysis.frames||[]).filter(frame=>frame.mistake!==false).map(frame=>{const linked=checkForFrame(frame,checks);return{...frame,label:(frame.label||'').includes('或')?(linked?.label||'具体动作问题'):frame.label,time:Number(frame.time)||0,start:Math.max(0,(Number(frame.time)||0)-2),end:(Number(frame.time)||0)+2,check:linked};});activeSegmentEnd=null;
  const checkpoints=activeMistakeSegments.map((item,index)=>`<button type="button" class="error-checkpoint ${index===0?'active':''}" data-error-checkpoint="${index}"><span>${String(index+1).padStart(2,'0')}</span><strong>${escapeHtml(item.label)}</strong><small>${item.time.toFixed(1)} 秒</small></button>`).join('');
  const goodText=good.length?`<section class="good-text"><span>做得好的地方</span><h3>这些动作值得继续保持</h3>${good.map(item=>`<p><b>✓ ${escapeHtml(item.label)}</b>${escapeHtml(item.feedback)}</p>`).join('')}</section>`:'';
  const unknownText=unknown.length?`<p class="analysis-unknown">${unknown.map(item=>`${escapeHtml(item.label)}：${escapeHtml(item.measured)}`).join(' · ')}</p>`:'';
  const focus=activeMistakeSegments.length?`<section class="error-workbench"><div class="error-video"><video id="analysisVideo" src="${escapeHtml(analysis.videoUrl||'')}" controls preload="metadata" playsinline></video><div class="video-moment-label">动作窗口 = 手臂移动最明显的连续片段</div><div class="error-checkpoints">${checkpoints}</div></div><aside class="error-explanation" id="errorExplanation">${mistakeDetailHtml(activeMistakeSegments[0],0)}</aside></section>`:Number(analysis.movementConfidence)<45?`<section class="no-errors-found pending-contact"><strong>尚未生成动作建议</strong><p>身体关键点不够连续。请使用固定机位，并让球员在画面中更大、更清楚。</p></section>`:`<section class="no-errors-found"><strong>没有观察到达到提示阈值的动作模式</strong><p>继续保持当前的稳定动作；报告不会为了生成建议而编造问题。</p></section>`;
  const planAllowed=Number(analysis.movementConfidence)>=65&&(analysis.exercises||[]).length>0,planHtml=planAllowed?`<div class="analysis-plan-callout"><div><span>下一步</span><strong>查看可能有帮助的目标与练习</strong><p>这些建议来自身体动作轨迹，你可以逐项确认。</p></div><button type="button" id="reviewAnalysisPlan">查看并确认 →</button></div>`:`<div class="analysis-plan-callout plan-locked"><div><span>暂不自动加入训练计划</span><strong>先把这些观察当作参考</strong><p>动作轨迹清晰度达到 65% 后，系统才会推荐目标与练习。</p></div></div>`;
  document.querySelector('#analysisResult').innerHTML=`<article class="analysis-report analysis-report--focus"><header><div><span class="eyebrow eyebrow--green">${escapeHtml(analysis.name||analysis.movementName)} · 动作轨迹覆盖 ${analysis.coverage}%</span><h2>${escapeHtml(analysis.overall)}</h2><p>先描述画面中可见的身体动作，再给出可能的改进方向；不检测网球位置。</p></div><button class="new-analysis-button" id="newAnalysisButton" type="button">分析另一个视频</button></header>${confidenceHtml(analysis)}${focus}${goodText}${unknownText}${planHtml}</article>`;
  const video=document.querySelector('#analysisVideo');if(video&&activeMistakeSegments[0]){video.addEventListener('loadedmetadata',()=>{video.currentTime=Math.min(activeMistakeSegments[0].time,video.duration||activeMistakeSegments[0].time);},{once:true});video.addEventListener('timeupdate',()=>{if(activeSegmentEnd!==null&&video.currentTime>=activeSegmentEnd){video.pause();activeSegmentEnd=null;}});}
  const manualVideo=document.querySelector('#manualContactVideo'),manualRange=document.querySelector('#manualContactRange'),manualTime=document.querySelector('#manualContactTime');if(manualVideo&&manualRange&&manualTime){manualVideo.addEventListener('loadedmetadata',()=>{const initial=Math.min(Number(manualVideo.dataset.initialTime)||0,manualVideo.duration||0);manualVideo.currentTime=initial;manualRange.max=String(manualVideo.duration||1);manualRange.value=String(initial);manualTime.textContent=`${initial.toFixed(2)} 秒`;},{once:true});manualVideo.addEventListener('timeupdate',()=>{if(!manualRange.matches(':active'))manualRange.value=String(manualVideo.currentTime);manualTime.textContent=`${manualVideo.currentTime.toFixed(2)} 秒`;});}
}
function analysisDateLabel(item){const date=new Date(item.createdAt);return Number.isNaN(date.getTime())?'未记录时间':new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);}
function renderAnalysisHistory() {
  const analyses=currentAccount()?.analyses||[];
  if(analyses.length&&!document.querySelector('#analysisResult .analysis-report'))renderAnalysis(analyses[0]);
  document.querySelector('#analysisHistory').innerHTML=analyses.length?`<div class="analysis-history-head"><div><span>分析档案</span><h3>历史分析</h3></div><strong>${analyses.length} 份</strong></div><div class="analysis-history-list">${analyses.map(item=>`<article class="analysis-history-item"><button type="button" class="analysis-history-main" data-analysis-open="${item.id}"><span>${escapeHtml(item.name||analysisDateLabel(item))}</span><strong>${escapeHtml(analysisDateLabel(item))}</strong></button><div class="analysis-history-actions"><button type="button" data-analysis-rename="${item.id}">重命名</button><button type="button" data-analysis-delete="${item.id}">删除</button></div></article>`).join('')}</div>`:'';
}

function openCalendarDay(date) {
  const account=currentAccount(); if(!account)return; currentDayContext=date;
  const matches=sortedMatches(account.matches.filter(match=>match.date===date)), scheduled=account.scheduledMatches.filter(item=>item.date===date);
  document.querySelector('#dayTitle').textContent=formatDate(date); let html='';
  if(matches.length)html+=`<section class="day-section"><h3>已记录比赛</h3><div class="real-match-list">${matches.map(matchCard).join('')}</div></section>`;
  if(scheduled.length)html+=`<section class="day-section"><h3>未来安排</h3>${scheduled.map(item=>`<article class="day-schedule"><strong>对阵 ${escapeHtml(item.opponent)}</strong><span>${escapeHtml(item.type)}${item.location?` · ${escapeHtml(item.location)}`:''}</span></article>`).join('')}</section>`;
  document.querySelector('#dayContent').innerHTML=html||'<div class="day-empty">这一天没有比赛记录或安排。</div>'; document.querySelector('#dayModal').showModal();
}
function openMatchDetail(matchId, fromDay='') {
  const match=currentAccount()?.matches.find(item=>String(item.id)===String(matchId)); if(!match)return;
  currentDetailMatchId=String(match.id); currentDayContext=fromDay;
  document.querySelector('#backToDay').hidden=!fromDay; document.querySelector('#detailTitle').textContent=`对阵 ${match.opponent}`;
  document.querySelector('#detailMeta').textContent=`${formatDate(match.date)} · ${match.matchType||'单打'} · ${match.surface}`;
  document.querySelector('#detailScore').innerHTML=`<span>${match.result}</span><strong>${escapeHtml(scoreText(match))}</strong>`;
  document.querySelector('#detailSatisfaction').textContent=satisfactionEmoji(match.satisfaction);
  const note=document.querySelector('#detailNote'); note.hidden=!match.note; note.textContent=match.note||'';
  document.querySelector('#matchDetailModal').showModal();
}
function resetMatchForm() {
  editingMatchId=''; const form=document.querySelector('#matchForm'); form.reset(); document.querySelector('#matchDate').value=localDateValue();
  document.querySelectorAll('.tiebreak-inputs').forEach(row=>row.hidden=true); document.querySelector('#scoreError').hidden=true;
  document.querySelector('#matchSubmitButton').innerHTML='保存比赛记录 <span>→</span>'; document.querySelector('#cancelMatchEdit').hidden=true;
}
function editCurrentMatch() {
  const match=currentAccount()?.matches.find(item=>String(item.id)===currentDetailMatchId); if(!match)return; resetMatchForm(); editingMatchId=String(match.id);
  document.querySelector('#opponent').value=match.opponent; document.querySelector('#matchDate').value=match.date; document.querySelector('#surface').value=match.surface;
  document.querySelector(`input[name="matchType"][value="${match.matchType||'单打'}"]`).checked=true; document.querySelector(`input[name="satisfaction"][value="${satisfactionEmoji(match.satisfaction)}"]`).checked=true; document.querySelector('#matchNote').value=match.note||'';
  const blocks=[...document.querySelectorAll('.set-block')]; match.sets.forEach((set,index)=>{const block=blocks[index];block.querySelector('.player-score').value=set.player;block.querySelector('.opponent-score').value=set.opponent;if(set.tiebreak){block.querySelector('.tiebreak-check').checked=true;block.querySelector('.tiebreak-inputs').hidden=false;block.querySelector('.tiebreak-player').value=set.tiebreak.player;block.querySelector('.tiebreak-opponent').value=set.tiebreak.opponent;}});
  document.querySelector('#matchSubmitButton').innerHTML='保存修改 <span>→</span>'; document.querySelector('#cancelMatchEdit').hidden=false; document.querySelector('#matchDetailModal').close(); showView('new-match');
}
function showScoreError(message){const box=document.querySelector('#scoreError');document.querySelector('#scoreErrorText').textContent=message;box.hidden=false;box.scrollIntoView({behavior:'smooth',block:'center'});}
function collectValidSets(){
  const raw=[...document.querySelectorAll('.set-block')].map((block,index)=>({index,player:block.querySelector('.player-score').value,opponent:block.querySelector('.opponent-score').value,hasTb:block.querySelector('.tiebreak-check').checked,tbPlayer:block.querySelector('.tiebreak-player').value,tbOpponent:block.querySelector('.tiebreak-opponent').value})).filter(s=>s.player!==''||s.opponent!=='');
  if(!raw.length){showScoreError('请至少填写两盘有效比分。');return null;} if(raw.some((s,i)=>s.index!==i)){showScoreError('请按顺序填写每一盘，不能跳过中间盘。');return null;} const sets=[];
  for(const set of raw){const label=`第 ${set.index+1} 盘`;if(set.player===''||set.opponent===''){showScoreError(`${label}需要同时填写双方局数。`);return null;}const p=Number(set.player),o=Number(set.opponent),high=Math.max(p,o),low=Math.min(p,o),diff=high-low;if(p===o){showScoreError(`${label}不能以平局结束。`);return null;}if(high<6){showScoreError(`${label}无效：赢家需至少取得 6 局。`);return null;}if(high===7&&low===6){if(!set.hasTb||set.tbPlayer===''||set.tbOpponent===''){showScoreError(`${label}为 7–6，必须填写双方抢七分数。`);return null;}const tp=Number(set.tbPlayer),to=Number(set.tbOpponent);if(Math.max(tp,to)<7||Math.abs(tp-to)<2){showScoreError(`${label}抢七无效：赢家需至少 7 分，并领先至少 2 分。`);return null;}if((p>o&&tp<=to)||(o>p&&to<=tp)){showScoreError(`${label}的抢七赢家必须与盘分赢家一致。`);return null;}sets.push({player:String(p),opponent:String(o),tiebreak:{player:String(tp),opponent:String(to)}});}else{if(diff<2){showScoreError(`${label}无效：赢家需至少 6 局，并领先至少 2 局；7–6 时必须填写抢七。`);return null;}if(set.hasTb){showScoreError(`${label}只有在盘分为 7–6 时才需要抢七比分。`);return null;}sets.push({player:String(p),opponent:String(o)});}}
  let won=0,lost=0;sets.forEach(set=>Number(set.player)>Number(set.opponent)?won++:lost++);if(won<2&&lost<2){showScoreError('三盘两胜制中，一方需要赢得至少两盘。');return null;}return{sets,won,lost};
}

loginForm.addEventListener('submit',async event=>{event.preventDefault();setError('#loginError');const email=document.querySelector('#email').value.trim().toLowerCase(),account=accounts()[email];if(!account||account.passwordHash!==await hashPassword(document.querySelector('#password').value)){setError('#loginError','邮箱或密码不正确。没有账户时，请先创建账户。');return;}currentEmail=email;openApp();showToast('登录成功');});
document.querySelector('#signupButton').addEventListener('click',()=>{setError('#signupError');signupModal.showModal();});document.querySelector('#signupClose').addEventListener('click',()=>signupModal.close());
document.querySelector('#signupForm').addEventListener('submit',async event=>{event.preventDefault();const name=document.querySelector('#signupName').value.trim(),email=document.querySelector('#signupEmail').value.trim().toLowerCase(),password=document.querySelector('#signupPassword').value,confirmPassword=document.querySelector('#signupConfirm').value,data=accounts();if(password!==confirmPassword){setError('#signupError','两次输入的密码不一致。');return;}if(data[email]){setError('#signupError','此邮箱已经注册，请直接登录。');return;}data[email]={name,email,passwordHash:await hashPassword(password),matches:[],goals:[],scheduledMatches:[],exercises:[],analyses:[],createdAt:new Date().toISOString()};saveAccounts(data);currentEmail=email;signupModal.close();event.currentTarget.reset();openApp();showToast('账户已创建');});
document.querySelector('#togglePassword').addEventListener('click',event=>{const input=document.querySelector('#password');input.type=input.type==='password'?'text':'password';event.currentTarget.textContent=input.type==='password'?'显示':'隐藏';});document.querySelector('#forgotOpen').addEventListener('click',()=>forgotModal.showModal());document.querySelector('#forgotForm .modal-close').addEventListener('click',()=>forgotModal.close());
document.querySelector('#forgotForm').addEventListener('submit',async event=>{event.preventDefault();const email=document.querySelector('#resetEmail').value.trim().toLowerCase(),data=accounts();if(!data[email]){setError('#resetError','没有找到使用此邮箱注册的账户。');return;}data[email].passwordHash=await hashPassword(document.querySelector('#resetPassword').value);saveAccounts(data);forgotModal.close();event.currentTarget.reset();document.querySelector('#email').value=email;showToast('密码已更新');});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();showView(button.dataset.view);}));document.querySelector('#menuButton').addEventListener('click',()=>sidebar.classList.add('open'));document.querySelector('#sidebarClose').addEventListener('click',()=>sidebar.classList.remove('open'));
['#recentMatches','#allMatches'].forEach(selector=>document.querySelector(selector).addEventListener('click',event=>{const card=event.target.closest('[data-match-id]');if(card)openMatchDetail(card.dataset.matchId);}));
document.querySelector('#matchDetailClose').addEventListener('click',()=>document.querySelector('#matchDetailModal').close());document.querySelector('#editMatchButton').addEventListener('click',editCurrentMatch);document.querySelector('#deleteMatchButton').addEventListener('click',()=>{const id=currentDetailMatchId;openConfirm('删除这场比赛？','比分、复盘以及由此生成的训练建议都会被删除。此操作无法撤销。',()=>{updateAccount(account=>{account.matches=account.matches.filter(match=>String(match.id)!==id);account.exercises=account.exercises.filter(item=>String(item.generatedFrom)!==id);});document.querySelector('#matchDetailModal').close();renderData();renderCalendar();renderExercises();if(currentDayContext)openCalendarDay(currentDayContext);showToast('比赛已删除');});});
document.querySelector('#backToDay').addEventListener('click',()=>{const date=currentDayContext;document.querySelector('#matchDetailModal').close();openCalendarDay(date);});
document.querySelector('#scheduleToggle').addEventListener('click',()=>{document.querySelector('#scheduleDate').value=localDateValue();document.querySelector('#scheduleModal').showModal();});document.querySelector('#scheduleClose').addEventListener('click',()=>document.querySelector('#scheduleModal').close());document.querySelector('#scheduleForm').addEventListener('submit',event=>{event.preventDefault();const item={id:Date.now(),date:document.querySelector('#scheduleDate').value,opponent:document.querySelector('#scheduleOpponent').value.trim(),type:document.querySelector('#scheduleType').value,location:document.querySelector('#scheduleLocation').value.trim()};updateAccount(account=>account.scheduledMatches.push(item));calendarCursor=new Date(`${item.date}T12:00:00`);event.currentTarget.reset();document.querySelector('#scheduleModal').close();renderCalendar();renderData();showToast('比赛已加入日历');});
document.querySelector('#calendarPrev').addEventListener('click',()=>{calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()-1,1);renderCalendar();});document.querySelector('#calendarNext').addEventListener('click',()=>{calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()+1,1);renderCalendar();});document.querySelector('#calendarGrid').addEventListener('click',event=>{const day=event.target.closest('[data-calendar-date]');if(day)openCalendarDay(day.dataset.calendarDate);});document.querySelector('#dayClose').addEventListener('click',()=>document.querySelector('#dayModal').close());document.querySelector('#dayContent').addEventListener('click',event=>{const card=event.target.closest('[data-match-id]');if(!card)return;const date=currentDayContext;document.querySelector('#dayModal').close();openMatchDetail(card.dataset.matchId,date);});
document.querySelector('#goalTitle').addEventListener('input',event=>{const dateInput=document.querySelector('#goalDate'),hint=document.querySelector('#goalDateHint');if(/未来\s*[4四]\s*周|接下来\s*[4四]\s*周|四周内/i.test(event.target.value)&&!dateInput.value){dateInput.value=dateAfterDays(28);hint.textContent='已自动设置为四周后';}else if(dateInput.value!==dateAfterDays(28))hint.textContent='';});
document.querySelector('#goalForm').addEventListener('submit',event=>{event.preventDefault();const title=document.querySelector('#goalTitle').value.trim(),date=inferredGoalDate(title,document.querySelector('#goalDate').value);openPlanReview({goal:title,date,exercises:recommendedExercises(title)});});
['#activeGoalList','#completedGoalList'].forEach(selector=>{const list=document.querySelector(selector);list.addEventListener('change',event=>{const input=event.target.closest('[data-goal-check]');if(!input)return;updateAccount(account=>{const goal=account.goals.find(item=>String(item.id)===input.dataset.goalCheck);if(goal)goal.completed=input.checked;});renderGoals();});list.addEventListener('click',event=>{const button=event.target.closest('[data-goal-delete]');if(!button)return;const id=button.dataset.goalDelete;openConfirm('删除这个训练目标？','删除后将无法恢复，已经完成的进度也会一并移除。',()=>{updateAccount(account=>account.goals=account.goals.filter(item=>String(item.id)!==id));renderGoals();showToast('目标已删除');});});});
document.querySelector('#exerciseForm').addEventListener('submit',event=>{event.preventDefault();updateAccount(account=>account.exercises.unshift({id:Date.now(),title:document.querySelector('#exerciseTitle').value.trim(),completed:false}));event.currentTarget.reset();renderExercises();showToast('练习已添加');});
document.querySelector('#exerciseExamplesToggle').addEventListener('click',event=>{const examples=document.querySelector('#exerciseExamples');examples.hidden=!examples.hidden;event.currentTarget.textContent=examples.hidden?'不知道练什么？查看示例':'收起练习示例';});
document.querySelector('#exerciseExamples').addEventListener('click',event=>{const button=event.target.closest('[data-exercise-example]');if(!button)return;const title=button.dataset.exerciseExample;const exists=(currentAccount()?.exercises||[]).some(item=>item.title===title&&!item.completed);if(exists){showToast('这个练习已经在待完成列表中');return;}updateAccount(account=>account.exercises.unshift({id:Date.now(),title,completed:false}));renderExercises();showToast('练习已加入');});
['#activeExerciseList','#completedExerciseList'].forEach(selector=>{const list=document.querySelector(selector);list.addEventListener('change',event=>{const input=event.target.closest('[data-exercise-check]');if(!input)return;updateAccount(account=>{const item=account.exercises.find(ex=>String(ex.id)===input.dataset.exerciseCheck);if(item)item.completed=input.checked;});renderExercises();});list.addEventListener('click',event=>{const button=event.target.closest('[data-exercise-delete]');if(!button)return;const id=button.dataset.exerciseDelete;const item=currentAccount()?.exercises.find(exercise=>String(exercise.id)===id);const isSuggestion=Boolean(item?.generatedFrom&&!item.completed);openConfirm(isSuggestion?'忽略这条训练建议？':'删除这个练习？',isSuggestion?'忽略后，这条建议将从待完成练习中移除。':'删除后将无法恢复，确定要继续吗？',()=>{updateAccount(account=>account.exercises=account.exercises.filter(exercise=>String(exercise.id)!==id));renderExercises();showToast(isSuggestion?'已忽略这条建议':'练习已删除');});});});
document.querySelector('#confirmCancel').addEventListener('click',()=>{pendingConfirmAction=null;document.querySelector('#confirmModal').close();});
document.querySelector('#confirmAccept').addEventListener('click',()=>{const action=pendingConfirmAction;pendingConfirmAction=null;document.querySelector('#confirmModal').close();if(action)action();});
document.querySelector('#confirmModal').addEventListener('cancel',()=>{pendingConfirmAction=null;});
document.querySelector('#planReviewClose').addEventListener('click',closePlanReview);document.querySelector('#planReviewCancel').addEventListener('click',closePlanReview);document.querySelector('#planReviewModal').addEventListener('cancel',()=>{pendingPlan=null;});
document.querySelector('#planReviewConfirm').addEventListener('click',()=>{if(!pendingPlan)return;const plan=pendingPlan;const addGoal=Boolean(document.querySelector('[data-plan-goal]:checked'));const selected=[...document.querySelectorAll('[data-plan-exercise]:checked')].map(input=>plan.exercises[Number(input.dataset.planExercise)]);if(!addGoal&&!selected.length){showToast('请至少选择一项目标或练习');return;}const goalDate=inferredGoalDate(plan.goal,plan.date);updateAccount(account=>{if(addGoal&&plan.goal&&!account.goals.some(item=>item.title===plan.goal&&!item.completed))account.goals.unshift({id:Date.now(),title:plan.goal,date:goalDate,completed:false,generatedFromAnalysis:plan.analysisId||''});selected.reverse().forEach((title,index)=>{if(!account.exercises.some(item=>item.title===title&&!item.completed))account.exercises.unshift({id:Date.now()+index,title,completed:false,generatedFromAnalysis:plan.analysisId||''});});if(plan.analysisId){const analysis=account.analyses.find(item=>item.id===plan.analysisId);if(analysis)analysis.planAccepted=true;}});document.querySelector('#goalForm').reset();document.querySelector('#goalDateHint').textContent='';closePlanReview();renderGoals();renderExercises();showToast('已加入你的训练计划');});
async function analyzeSelectedPlayer(candidate){const loading=document.querySelector('#analysisLoading'),button=document.querySelector('#analyzeButton');loading.hidden=false;document.querySelector('#analysisLoadingTitle').textContent='正在分析选定球员的整场比赛';button.disabled=true;setError('#analysisError');try{const response=await fetch('/api/analyze-match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uploadId:pendingVideoAnalysis.uploadId,bbox:candidate.bbox})});const result=await response.json();if(!response.ok)throw new Error(result.error||'整段视频分析未完成');result.createdAt=new Date().toISOString();result.selectedPlayer=candidate.label;result.uploadId=result.uploadId||pendingVideoAnalysis.uploadId;result.playerBBox=result.playerBBox||candidate.bbox;updateAccount(account=>{account.analyses=account.analyses||[];account.analyses.unshift(result);});renderAnalysis(result);renderAnalysisHistory();document.querySelector('#playerSelection').hidden=true;button.hidden=false;showToast('整场比赛分析完成');}catch(error){setError('#analysisError',error.message||'整段视频分析未完成，请重试。');}finally{loading.hidden=true;button.disabled=false;}}
document.querySelector('#motionVideo').addEventListener('change',event=>{const file=event.target.files[0],preview=document.querySelector('#motionPreview');if(motionPreviewUrl)URL.revokeObjectURL(motionPreviewUrl);pendingVideoAnalysis=null;document.querySelector('#playerSelection').hidden=true;document.querySelector('#analyzeButton').hidden=false;if(!file){preview.hidden=true;document.querySelector('#motionFileName').textContent='选择比赛视频';return;}motionPreviewUrl=URL.createObjectURL(file);preview.src=motionPreviewUrl;preview.hidden=false;document.querySelector('#motionFileName').textContent=file.name;setError('#analysisError');});
document.querySelector('#motionForm').addEventListener('submit',async event=>{event.preventDefault();const file=document.querySelector('#motionVideo').files[0];if(!file)return;if(file.size>250*1024*1024){setError('#analysisError','视频不能超过 250 MB。');return;}const loading=document.querySelector('#analysisLoading'),button=document.querySelector('#analyzeButton');loading.hidden=false;document.querySelector('#analysisLoadingTitle').textContent='正在识别视频中的球员';button.disabled=true;setError('#analysisError');const form=new FormData();form.append('video',file);try{const response=await fetch('/api/prepare-analysis',{method:'POST',body:form});const result=await response.json();if(!response.ok)throw new Error(result.error||'球员识别未完成');pendingVideoAnalysis=result;if(result.candidates.length===1){await analyzeSelectedPlayer(result.candidates[0]);return;}document.querySelector('#playerCandidates').innerHTML=result.candidates.map((candidate,index)=>`<label class="player-candidate"><input type="radio" name="selectedPlayer" value="${index}" ${index===0?'checked':''}/><span><img src="${escapeHtml(candidate.thumbnail)}" alt="${escapeHtml(candidate.label)}"/><strong>${escapeHtml(candidate.label)}</strong><small>球员 ${index+1}</small></span></label>`).join('');document.querySelector('#playerSelection').hidden=false;button.hidden=true;showToast('请选择要分析的球员');}catch(error){setError('#analysisError',error.message||'球员识别未完成，请重试。');}finally{loading.hidden=true;button.disabled=false;}});
document.querySelector('#confirmPlayerButton').addEventListener('click',()=>{const selected=document.querySelector('input[name="selectedPlayer"]:checked');if(!selected||!pendingVideoAnalysis)return;analyzeSelectedPlayer(pendingVideoAnalysis.candidates[Number(selected.value)]);});
document.querySelector('#analysisResult').addEventListener('click',async event=>{const restart=event.target.closest('#newAnalysisButton');if(restart){document.querySelector('.motion-layout').classList.remove('has-report');document.querySelector('#motionForm').reset();document.querySelector('#motionPreview').hidden=true;document.querySelector('#playerSelection').hidden=true;document.querySelector('#analyzeButton').hidden=false;document.querySelector('#motionFileName').textContent='选择比赛视频';document.querySelector('#analysisResult').innerHTML='<div class="analysis-empty"><span>◎</span><h2>等待一场比赛</h2><p>完成分析后，这里会显示动作窗口、身体轨迹观察和可能的改进方向。</p></div>';currentAnalysisId='';activeMistakeSegments=[];return;}const review=event.target.closest('#reviewAnalysisPlan');if(review){const analysis=currentAccount()?.analyses?.find(item=>item.id===currentAnalysisId);if(analysis)openPlanReview({goal:analysis.goal,exercises:analysis.exercises||[],analysisId:analysis.id,message:'这些建议来自视频中的身体动作轨迹。请确认你愿意尝试的目标和练习。'});return;}const checkpoint=event.target.closest('[data-error-checkpoint]');if(checkpoint){const index=Number(checkpoint.dataset.errorCheckpoint),segment=activeMistakeSegments[index],video=document.querySelector('#analysisVideo');document.querySelectorAll('[data-error-checkpoint]').forEach(item=>item.classList.toggle('active',item===checkpoint));document.querySelector('#errorExplanation').innerHTML=mistakeDetailHtml(segment,index);if(video){video.pause();activeSegmentEnd=null;video.currentTime=segment.time;}return;}const freeze=event.target.closest('[data-freeze-error]');if(freeze){const segment=activeMistakeSegments[Number(freeze.dataset.freezeError)],video=document.querySelector('#analysisVideo');if(!video||!segment)return;video.pause();video.playbackRate=1;activeSegmentEnd=null;video.currentTime=segment.time;video.scrollIntoView({behavior:'smooth',block:'center'});return;}const coaching=event.target.closest('[data-open-coaching]');if(coaching){const index=Number(coaching.dataset.openCoaching),segment=activeMistakeSegments[index];if(!segment)return;const coach=coachingFor(segment);document.querySelector('#coachingModalTitle').textContent=coach.title;document.querySelector('#coachingModalChapter').textContent=`${coach.source} · ${coach.chapter}`;document.querySelector('#coachingModalPlayer').innerHTML=`<iframe src="https://www.youtube-nocookie.com/embed/${coach.id}?start=${coach.start}&autoplay=1&rel=0" title="${escapeHtml(coach.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;document.querySelector('#coachingVideoModal').showModal();return;}const play=event.target.closest('[data-play-error]');if(play){const segment=activeMistakeSegments[Number(play.dataset.playError)],video=document.querySelector('#analysisVideo');if(!video)return;video.pause();video.playbackRate=Number(play.dataset.rate)||1;video.currentTime=segment.start;activeSegmentEnd=segment.end;video.play();return;}const openImage=event.target.closest('[data-open-error-image]');if(openImage){const segment=activeMistakeSegments[Number(openImage.dataset.openErrorImage)];document.querySelector('#lightboxImage').src=segment.url;document.querySelector('#lightboxCaption').textContent=`${segment.label} · ${segment.time.toFixed(2)} 秒`;document.querySelector('#imageLightbox').showModal();}});
document.querySelector('#imageLightboxClose').addEventListener('click',()=>document.querySelector('#imageLightbox').close());document.querySelector('#imageLightbox').addEventListener('click',event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
function closeCoachingVideo(){document.querySelector('#coachingVideoModal').close();document.querySelector('#coachingModalPlayer').innerHTML='';}
document.querySelector('#coachingModalClose').addEventListener('click',closeCoachingVideo);document.querySelector('#coachingVideoModal').addEventListener('cancel',event=>{event.preventDefault();closeCoachingVideo();});document.querySelector('#coachingVideoModal').addEventListener('click',event=>{if(event.target===event.currentTarget)closeCoachingVideo();});
function closeAnalysisName(){renamingAnalysisId='';document.querySelector('#analysisNameModal').close();}
document.querySelector('#analysisNameClose').addEventListener('click',closeAnalysisName);document.querySelector('#analysisNameModal').addEventListener('cancel',()=>{renamingAnalysisId='';});document.querySelector('#analysisNameForm').addEventListener('submit',event=>{event.preventDefault();const name=document.querySelector('#analysisNameInput').value.trim();if(!name||!renamingAnalysisId)return;updateAccount(account=>{const analysis=account.analyses.find(item=>item.id===renamingAnalysisId);if(analysis)analysis.name=name;});const renamedId=renamingAnalysisId;closeAnalysisName();renderAnalysisHistory();if(currentAnalysisId===renamedId){const analysis=currentAccount()?.analyses?.find(item=>item.id===renamedId);if(analysis)renderAnalysis(analysis);}showToast('分析名称已保存');});
document.querySelector('#analysisHistory').addEventListener('click',event=>{const open=event.target.closest('[data-analysis-open]');if(open){const analysis=currentAccount()?.analyses?.find(item=>item.id===open.dataset.analysisOpen);if(analysis){renderAnalysis(analysis);document.querySelector('#analysisResult').scrollIntoView({behavior:'smooth',block:'start'});}return;}const rename=event.target.closest('[data-analysis-rename]');if(rename){const analysis=currentAccount()?.analyses?.find(item=>item.id===rename.dataset.analysisRename);if(!analysis)return;renamingAnalysisId=analysis.id;document.querySelector('#analysisNameInput').value=analysis.name||analysisDateLabel(analysis);document.querySelector('#analysisNameModal').showModal();document.querySelector('#analysisNameInput').select();return;}const remove=event.target.closest('[data-analysis-delete]');if(remove){const id=remove.dataset.analysisDelete;openConfirm('删除这份视频分析？','报告、动作截图和改进建议将从分析历史中移除。',()=>{updateAccount(account=>account.analyses=account.analyses.filter(item=>item.id!==id));if(currentAnalysisId===id){currentAnalysisId='';activeMistakeSegments=[];document.querySelector('.motion-layout').classList.remove('has-report');document.querySelector('#analysisResult').innerHTML='<div class="analysis-empty"><span>◎</span><h2>等待一场比赛</h2><p>上传视频后，这里会显示新的动作分析。</p></div>';}renderAnalysisHistory();showToast('分析已删除');});}});
document.querySelector('#logoutButton').addEventListener('click',()=>{currentEmail='';sessionStorage.removeItem('tennis-current-user');appShell.hidden=true;loginPage.hidden=false;loginForm.reset();});
document.querySelectorAll('.tiebreak-check').forEach(input=>input.addEventListener('change',()=>{const row=input.closest('.set-block').querySelector('.tiebreak-inputs');row.hidden=!input.checked;if(!input.checked)row.querySelectorAll('input').forEach(field=>field.value='');}));document.querySelector('#cancelMatchEdit').addEventListener('click',()=>{resetMatchForm();showView('overview');});
document.querySelector('#matchForm').addEventListener('submit',event=>{event.preventDefault();const valid=collectValidSets();if(!valid)return;const wasEditing=Boolean(editingMatchId);const editId=editingMatchId;const note=document.querySelector('#matchNote').value.trim();const id=editId||String(Date.now());const match={id:Number(id),opponent:document.querySelector('#opponent').value.trim(),date:document.querySelector('#matchDate').value,surface:document.querySelector('#surface').value,sets:valid.sets,matchType:document.querySelector('input[name="matchType"]:checked').value,satisfaction:document.querySelector('input[name="satisfaction"]:checked').value,note,result:valid.won>valid.lost?'胜':'负'};let suggestions=0;updateAccount(account=>{if(wasEditing){const index=account.matches.findIndex(item=>String(item.id)===editId);if(index>=0)account.matches[index]=match;}else account.matches.push(match);suggestions=generateExercises(note,match.id,account);});resetMatchForm();renderData();renderCalendar();renderExercises();showView('overview');showToast(wasEditing?'比赛已更新':suggestions?`比赛已保存，并生成 ${suggestions} 条训练建议`:'比赛已保存');openMatchDetail(match.id);});

document.querySelector('#matchDate').value=localDateValue();document.querySelector('#scheduleDate').min=localDateValue();document.querySelector('#goalDate').min=localDateValue();
async function initializeApp() {
  try {
    const response = await fetch('/api/accounts', {cache:'no-store'});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '数据库读取失败');
    accountsCache = result;
    let legacy = {};
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)) || {}; } catch {}
    if (!Object.keys(accountsCache).length && Object.keys(legacy).length) {
      accountsCache = legacy;
      await saveAccounts(accountsCache);
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    await refreshStorageStatus();
    if (currentAccount()) openApp();
  } catch (error) {
    setError('#loginError',error.message || '无法连接网站数据库，请确认服务器正在运行。');
  }
}
initializeApp();
