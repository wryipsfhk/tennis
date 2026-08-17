const loginPage = document.querySelector('#loginPage');
const appShell = document.querySelector('#appShell');
const loginForm = document.querySelector('#loginForm');
const loginModal = document.querySelector('#loginModal');
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
  overview: ['Today', 'Home'], 'new-match': ['Match Journal', 'Log a Match'],
  analysis: ['Movement Lab', 'Movement Analysis'],
  history: ['Progress Archive', 'Progress Trends'], matches: ['Match Archive', 'All Matches'],
  calendar: ['Match Schedule', 'Match Calendar'], goals: ['Training Plan', 'Training Goals'],
  exercises: ['From Reflection to Practice', 'Training Plan']
};

const legacyValues = {
  '\u5355\u6253':'Singles', '\u53cc\u6253':'Doubles', '\u786c\u5730':'Hard', '\u7ea2\u571f':'Clay',
  '\u8349\u5730':'Grass', '\u5ba4\u5185\u5730\u6bef':'Indoor Carpet', '\u80dc':'Win', '\u8d1f':'Loss'
};
function englishValue(value, fallback='') { return legacyValues[value] || value || fallback; }
function isWin(match) { return englishValue(match?.result) === 'Win'; }
function normalizeAccountValues(account) {
  account.matches.forEach(match => { match.matchType=englishValue(match.matchType,'Singles'); match.surface=englishValue(match.surface); match.result=englishValue(match.result); });
  account.scheduledMatches.forEach(item => { item.type=englishValue(item.type,'Singles'); });
}

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
    ? 'JSONBin synced'
    : storageState.configured ? (storageState.backend === 'sqlite-backup' ? 'Cloud offline · Local backup available' : 'Cloud connection failed · Check settings') : 'Waiting for JSONBin';
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
    if (!response.ok) throw new Error(result.error || 'Could not save to the database');
    renderStorageStatus({configured:result.storage === 'jsonbin' || storageState.configured, connected:result.storage === 'jsonbin', backend:result.storage, message:result.storage === 'jsonbin' ? 'Synced to JSONBin' : storageState.message});
  }).catch(error => {
    refreshStorageStatus();
    showToast(error.message || 'Your data could not be saved. Check the website server.');
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
  normalizeAccountValues(account);
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
function inferredGoalDate(title, date='') { return date || (/(next|within|over)\s+(the\s+)?(four|4)\s+weeks?/i.test(title) ? dateAfterDays(28) : ''); }
function formatDate(value) {
  return new Intl.DateTimeFormat('en', {year:'numeric', month:'long', day:'numeric'}).format(new Date(`${value}T12:00:00`));
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
  document.querySelector('#pageTitle').textContent = name === 'overview' && account ? `Hello, ${account.name}` : titles[name]?.[1] || '';
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
  if (loginModal?.open) loginModal.close();
  loginPage.hidden = true; appShell.hidden = false;
  sessionStorage.setItem('tennis-current-user', currentEmail);
  const initial = account.name.trim().charAt(0).toUpperCase() || 'Y';
  document.querySelector('#userAvatar').textContent = initial;
  document.querySelector('#userName').textContent = account.name;
  document.querySelector('#userEmail').textContent = account.email;
  currentAnalysisId='';document.querySelector('.motion-layout').classList.remove('has-report');document.querySelector('#analysisResult').innerHTML='<div class="analysis-empty"><span>◎</span><h2>Waiting for a match</h2><p>Your movement windows, observations, and possible improvements will appear here.</p></div>';document.querySelector('#analysisHistory').innerHTML='';
  renderData(); renderCalendar(); renderGoals(); renderExercises(); showView('overview');
}

function scoreText(match) {
  return match.sets.map(set => `${set.player}–${set.opponent}${set.tiebreak ? ` (${set.tiebreak.player}–${set.tiebreak.opponent})` : ''}`).join(' · ');
}
function matchCard(match) {
  const note = match.note ? `<p>${escapeHtml(match.note)}</p>` : '';
  return `<button type="button" class="real-match-card" data-match-id="${escapeHtml(match.id)}">
    <div><span>${escapeHtml(formatDate(match.date))} · ${escapeHtml(englishValue(match.matchType,'Singles'))} · ${escapeHtml(englishValue(match.surface))}</span><h3>vs ${escapeHtml(match.opponent)}</h3></div>
    <div class="real-score"><b class="${isWin(match) ? 'won' : ''}">${escapeHtml(englishValue(match.result))}</b><strong>${escapeHtml(scoreText(match))}</strong><span class="match-emoji">${satisfactionEmoji(match.satisfaction)}</span></div>
    ${note}<i class="card-arrow">View Details →</i></button>`;
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
    const monthWins = monthMatches.filter(isWin).length;
    document.querySelector('#totalMatches').textContent = matches.length;
    document.querySelector('#monthlyWinRate').textContent = monthMatches.length ? Math.round(monthWins / monthMatches.length * 100) : '—';
    document.querySelector('#monthlyWinRateUnit').textContent = monthMatches.length ? `% · ${monthWins}/${monthMatches.length} matches` : 'No matches this month';
    const chronological = [...matches].sort((a,b) => a.date.localeCompare(b.date) || Number(a.id)-Number(b.id));
    let currentStreak = 0, longestStreak = 0;
    chronological.forEach(match => { if (isWin(match)) { currentStreak++; longestStreak = Math.max(longestStreak, currentStreak); } else currentStreak = 0; });
    document.querySelector('#longestWinStreak').textContent = longestStreak;
    document.querySelector('#averageSatisfaction').textContent = satisfactionEmoji(matches[0].satisfaction);
    document.querySelector('#dashboardGreeting').textContent = matches.length === 1 ? 'Your First Match' : `Your ${Math.min(matches.length, 3)} Most Recent Matches`;
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
  if (empty) { document.querySelector('#historyMessage').textContent = 'Monthly trends will appear after you log matches.'; return; }
  const satisfaction = months.map(key => ({label:new Intl.DateTimeFormat('en',{month:'short'}).format(new Date(`${key}-01T12:00:00`)), value:Math.round(grouped[key].reduce((sum,m) => sum + satisfactionPercent(m.satisfaction),0) / grouped[key].length)}));
  const wins = months.map(key => ({label:new Intl.DateTimeFormat('en',{month:'short'}).format(new Date(`${key}-01T12:00:00`)), value:Math.round(grouped[key].filter(isWin).length / grouped[key].length * 100)}));
  document.querySelector('#satisfactionChart').innerHTML = chartHtml(satisfaction,'satisfaction-bar');
  document.querySelector('#winRateChart').innerHTML = chartHtml(wins,'win-bar');
  document.querySelector('#satisfactionTrendLatest').textContent = `${satisfaction[satisfaction.length-1].value}%`;
  document.querySelector('#winRateTrendLatest').textContent = `${wins[wins.length-1].value}%`;
  document.querySelector('#historyMessage').textContent = `Monthly summary based on ${matches.length} real ${matches.length===1?'match':'matches'}.`;
}

function daysUntil(date) { const today = new Date(); today.setHours(0,0,0,0); return Math.round((new Date(`${date}T00:00:00`) - today) / 86400000); }
function nextScheduledMatch() { const today = localDateValue(); return [...(currentAccount()?.scheduledMatches || [])].filter(item => item.date >= today).sort((a,b) => a.date.localeCompare(b.date))[0]; }
function countdownText(item) { if (!item) return 'No upcoming match scheduled.'; const days = daysUntil(item.date); return days === 0 ? 'Your next match is today.' : days === 1 ? 'Your next match is tomorrow.' : `Your next match is in ${days} days.`; }
function renderNextMatch() {
  const next = nextScheduledMatch(); const banner = document.querySelector('#nextMatchBanner'); banner.hidden = !next; if (!next) return;
  document.querySelector('#nextMatchCountdown').textContent = countdownText(next);
  document.querySelector('#nextMatchInfo').textContent = `${formatDate(next.date)} · ${englishValue(next.type,'Singles')} · vs ${next.opponent}${next.location ? ` · ${next.location}` : ''}`;
}
function renderCalendar() {
  const account = currentAccount(); if (!account) return; const today = localDateValue();
  document.querySelector('#calendarCountdown').textContent = countdownText(nextScheduledMatch());
  document.querySelector('#calendarTitle').textContent = new Intl.DateTimeFormat('en',{year:'numeric',month:'long'}).format(calendarCursor);
  const year = calendarCursor.getFullYear(), month = calendarCursor.getMonth();
  const offset = (new Date(year,month,1).getDay()+6)%7, total = new Date(year,month+1,0).getDate();
  const recorded = new Set(account.matches.map(match => match.date)), scheduled = new Set(account.scheduledMatches.map(item => item.date));
  const cells = Array.from({length:offset},() => '<span class="calendar-day empty"></span>');
  for (let day=1; day<=total; day++) { const date=`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`; const hasRecorded=recorded.has(date), hasScheduled=scheduled.has(date); const scheduledMarker=hasScheduled&&!hasRecorded?`<i class="${date<today?'recorded-dot':'scheduled-dot'}"></i>`:''; const markers=`${hasRecorded?'<i class="recorded-dot"></i>':''}${scheduledMarker}`; cells.push(`<button type="button" class="calendar-day ${date===today?'today':''}" data-calendar-date="${date}"><b>${day}</b><em>${markers}</em></button>`); }
  document.querySelector('#calendarGrid').innerHTML = cells.join('');
  const upcoming = [...account.scheduledMatches].filter(item=>item.date>=today).sort((a,b)=>a.date.localeCompare(b.date));
  document.querySelector('#upcomingMatches').innerHTML = upcoming.length ? upcoming.map(item=>`<article class="upcoming-item"><time>${formatDate(item.date)}</time><strong>vs ${escapeHtml(item.opponent)}</strong><span>${escapeHtml(englishValue(item.type,'Singles'))}${item.location?` · ${escapeHtml(item.location)}`:''}</span></article>`).join('') : '<p class="calendar-empty">No upcoming matches. Select Schedule Match to add one.</p>';
  renderNextMatch();
}

function goalHtml(goal) { return `<article class="goal-item ${goal.completed?'completed':''}"><label><input type="checkbox" data-goal-check="${goal.id}" ${goal.completed?'checked':''}/><span></span></label><div><strong>${escapeHtml(goal.title)}</strong>${goal.date?`<small>Target date: ${formatDate(goal.date)}</small>`:'<small>No target date</small>'}</div><button type="button" data-goal-delete="${goal.id}" aria-label="Delete goal">×</button></article>`; }
function renderGoals() {
  const goals = currentAccount()?.goals || [], active = goals.filter(g=>!g.completed), completed = goals.filter(g=>g.completed);
  document.querySelector('#activeGoalsEmpty').hidden = active.length>0; document.querySelector('#completedGoalsEmpty').hidden = completed.length>0;
  document.querySelector('#activeGoalList').innerHTML = active.map(goalHtml).join(''); document.querySelector('#completedGoalList').innerHTML = completed.map(goalHtml).join('');
  const badge=document.querySelector('#goalBadge');badge.hidden=active.length===0;badge.textContent=active.length;
  const today=new Date(`${localDateValue()}T12:00:00`);const dated=active.filter(goal=>goal.date).map(goal=>({...goal,days:Math.ceil((new Date(`${goal.date}T12:00:00`)-today)/86400000)})).sort((a,b)=>a.days-b.days);const notice=document.querySelector('#goalNotice');
  if(!dated.length){notice.hidden=true;}else{const next=dated[0];notice.hidden=false;notice.innerHTML=`<span>GOAL REMINDER</span><strong>${next.days<0?`${Math.abs(next.days)} days overdue`:next.days===0?'Due today':`${next.days} days left`}</strong><p>${escapeHtml(next.title)}</p>`;}
}
const exerciseRules = [
  {terms:['backhand error','backhand errors','unstable backhand'], title:'Backhand consistency: wall rally · 3 × 20 balls'},
  {terms:['serve was poor','serving poorly','double fault','second serve'], title:'Serve rhythm: toss practice · 3 × 15, then 30 second serves'},
  {terms:['footwork','slow movement','moving slowly'], title:'Six-point footwork · 4 × 45 seconds, 30 seconds rest'}
];
function generateExercises(note, matchId, account) {
  account.exercises = account.exercises.filter(item => String(item.generatedFrom) !== String(matchId));
  const generated = [];
  const normalizedNote = note.toLowerCase();
  exerciseRules.forEach(rule => { if (rule.terms.some(term => normalizedNote.includes(term))) generated.push({id:Date.now()+generated.length,title:rule.title,completed:false,generatedFrom:matchId,source:'Automatically suggested from match reflection'}); });
  account.exercises.unshift(...generated); return generated.length;
}
function exerciseHtml(item) {
  const buttonLabel = !item.completed && item.generatedFrom ? 'Dismiss' : 'Delete';
  return `<article class="exercise-item ${item.completed?'completed':''}"><label><input type="checkbox" data-exercise-check="${item.id}" ${item.completed?'checked':''}/><span></span></label><div><strong>${escapeHtml(item.title)}</strong></div><button type="button" data-exercise-delete="${item.id}">${buttonLabel}</button></article>`;
}
function renderExercises() {
  const exercises = currentAccount()?.exercises || [], active=exercises.filter(e=>!e.completed), completed=exercises.filter(e=>e.completed);
  document.querySelector('#exercisesEmpty').hidden = active.length>0; document.querySelector('#activeExerciseList').innerHTML = active.map(exerciseHtml).join('');
  document.querySelector('#completedExercisesSection').hidden = completed.length===0; document.querySelector('#completedExerciseList').innerHTML = completed.map(exerciseHtml).join('');
  const badge=document.querySelector('#exerciseBadge'); badge.hidden=active.length===0; badge.textContent=active.length;
}

const goalExerciseRules = [
  {terms:['serve','toss','double fault','second serve'], exercises:['Toss placement · 3 × 15','Second-serve spin · 3 × 20 balls']},
  {terms:['forehand'], exercises:['Forehand cross-court · 3 × 20 balls','Attacking forehand · 3 × 15 balls']},
  {terms:['backhand'], exercises:['Backhand cross-court · 3 × 20 balls','Backhand wall rally · 3 × 30 balls']},
  {terms:['footwork','movement','running'], exercises:['Six-point footwork · 4 × 45 seconds','Split-step starts · 3 × 12']},
  {terms:['net','volley'], exercises:['Net volleys · 10 minutes','Moving volleys · 3 × 12 balls']},
  {terms:['fitness','stamina','endurance'], exercises:['Court shuttle runs · 5 × 30 seconds','Jump rope · 3 × 3 minutes']}
];
function recommendedExercises(text) {
  const result=[];
  goalExerciseRules.forEach(rule=>{if(rule.terms.some(term=>text.toLowerCase().includes(term)))result.push(...rule.exercises);});
  return [...new Set(result.length?result:[`Focused practice for “${text}” · 3 × 10 reps`])].slice(0,4);
}
function openPlanReview({goal='', date='', exercises=[], analysisId='', message=''}) {
  date=inferredGoalDate(goal,date);
  pendingPlan={goal,date,exercises,analysisId};
  document.querySelector('#planReviewTitle').textContent=analysisId?'Confirm this improvement plan?':'Add this goal and the recommended drills?';
  document.querySelector('#planReviewMessage').textContent=message||'These drills were suggested from your goal. Select what you want to try.';
  let html='';
  if(goal)html+=`<label class="plan-choice plan-choice--goal"><input type="checkbox" data-plan-goal checked/><span><b>Training Goals</b><strong>${escapeHtml(goal)}</strong>${date?`<small>Target Date ${formatDate(date)}</small>`:''}</span></label>`;
  html+=exercises.map((title,index)=>`<label class="plan-choice"><input type="checkbox" data-plan-exercise="${index}" checked/><span><b>Training Drill</b><strong>${escapeHtml(title)}</strong></span></label>`).join('');
  document.querySelector('#planReviewList').innerHTML=html;
  document.querySelector('#planReviewModal').showModal();
}
function closePlanReview(){pendingPlan=null;document.querySelector('#planReviewModal').close();}
function analysisCheckHtml(item){const mark=item.status==='good'?'✓':item.status==='warn'?'↗':'?';const label=item.status==='good'?'Stable Pattern':item.status==='warn'?'Possible Improvement':'Not Enough Evidence';return `<article class="motion-check ${item.status}"><i>${mark}</i><div><span>${label}</span><h3>${escapeHtml(item.label)}</h3><b>${escapeHtml(item.measured)}</b><p>${escapeHtml(item.feedback)}</p></div></article>`;}
function preciseCheck(item){return item;}
function checkForFrame(frame, checks){if(frame.checkLabel){const exact=checks.find(item=>item.label===frame.checkLabel);if(exact)return exact;}return checks.find(item=>item.status==='warn');}
function englishMistake(segment){const label=(segment.check?.label||segment.label||'').toLowerCase();if(label.includes('rotation'))return{title:'Limited visible upper-body rotation',evidence:'Across the selected high-speed movement window, the projected shoulder line changed less than the review threshold.',advice:'Complete the shoulder and hip turn before letting the arm follow.'};if(label.includes('balance'))return{title:'Balance moved outside the base of support',evidence:'In part of the movement window, the projected hip centre moved beyond the area supported by both feet.',advice:'Lower your centre of mass and hold the finish for two seconds before beginning the recovery step.'};if(label.includes('stance'))return{title:'Stance width limited stability or recovery',evidence:'The visible ankle-to-ankle width was outside the comparison range relative to shoulder width.',advice:'Adjust toward a comfortable shoulder-width base, stay active with small steps, and recover immediately after the swing.'};if(label.includes('lower-body')||label.includes('knee'))return{title:'Limited visible knee flexion',evidence:'The knees remained relatively straight during the selected high-speed movement window.',advice:'Use a light knee bend during preparation, followed by a natural extension through the swing.'};if(label.includes('swing'))return{title:'Short visible swing path',evidence:'The racket-side wrist travelled a short distance relative to shoulder width during this movement window.',advice:'Rehearse a slow, continuous shadow swing before gradually adding speed.'};return{title:'Visible movement pattern',evidence:'This observation comes from the player’s body-keypoint path across several nearby frames.',advice:'Treat it as an improvement to test. Compare it with the replay and how the movement felt.'};}
const coachingVideo={id:'9T6ixfsb9Bc',source:'Top Tennis Training · Coach Simon Konov'};
function coachingFor(segment){
  const label=segment.check?.label||segment.label||'';
  if(/rotation|swing/i.test(label))return{...coachingVideo,start:530,chapter:'08:50 · Forehand loading and swing position',title:'Rotation and a connected swing',cue:'Complete the body preparation first, then let the arm follow. Compare the overall rhythm rather than copying a fixed elbow angle.'};
  if(/balance|stance|lower-body|knee/i.test(label))return{...coachingVideo,start:706,chapter:'11:46 · Forehand footwork and movement',title:'Stance, balance, and recovery',cue:'Watch the ready position, stability after movement, and the recovery step after the swing.'};
  return{...coachingVideo,start:706,chapter:'11:46 · Forehand footwork and movement',title:'Complete movement rhythm',cue:'Compare preparation, swing, and recovery using only the body pattern described in your report.'};
}
function coachingCardHtml(segment,index){const coach=coachingFor(segment);return `<section class="coaching-card"><div class="coaching-copy"><span>TECHNIQUE DEMONSTRATION</span><h4>${escapeHtml(coach.title)}</h4><p>${escapeHtml(coach.cue)}</p><small>${escapeHtml(coach.source)}<br>${escapeHtml(coach.chapter)}</small></div><div class="coaching-video-slot"><button type="button" class="coaching-play" data-open-coaching="${index}" aria-label="Open coaching video at ${escapeHtml(coach.chapter)}"><img src="https://i.ytimg.com/vi/${coach.id}/hqdefault.jpg" alt="${escapeHtml(coach.title)} coaching video thumbnail" loading="lazy"/><span><i>▶</i>Play Key Segment</span></button></div></section>`;}
function mistakeDetailHtml(segment,index){const english=englishMistake(segment);return `<span class="error-number">POSSIBLE IMPROVEMENT · ${String(index+1).padStart(2,'0')} · ${segment.time.toFixed(2)} sec</span><h3>${escapeHtml(segment.label)}</h3><b>${escapeHtml(segment.check?.measured||'Movement key frame')}</b><p>${escapeHtml(segment.check?.feedback||'Use the movement-window replay to decide whether this observation matches how the action felt.')}</p><div class="screenshot-actions"><button type="button" data-freeze-error="${index}">⏸ Freeze Observation</button><button type="button" data-open-error-image="${index}">Enlarge Screenshot</button></div><details class="english-feedback"><summary>Detailed Explanation</summary><div><h4>${escapeHtml(english.title)}</h4><b>${escapeHtml(english.evidence)}</b><p>${escapeHtml(english.advice)}</p></div></details><div class="error-play-actions"><button type="button" data-play-error="${index}" data-rate="1">▶ Play Movement Window</button><button type="button" data-play-error="${index}" data-rate="0.35">◷ Play in Slow Motion</button></div>${coachingCardHtml(segment,index)}`;}
function confidenceHtml(analysis){const confidence=Number(analysis.movementConfidence)||0;if(confidence>=80)return `<section class="confidence-status reliable"><strong>✓ Clear body-motion tracking</strong><p>Movement clarity: ${confidence}%. This report uses continuous body keypoints and does not detect the ball.</p></section>`;if(confidence>=45)return `<section class="confidence-status verify"><strong>Review as a possible improvement</strong><p>Movement clarity: ${confidence}%. Some body frames are discontinuous, so compare the observation with the replay and how it felt.</p></section>`;return `<section class="confidence-status manual"><strong>Body-motion tracking is not clear enough</strong><p>Movement clarity: ${confidence}%. The system will not create technique advice from too few body frames.</p></section>`;}
function manualContactHtml(){return '';}
function renderAnalysis(analysis) {
  if(!analysis)return;
  currentAnalysisId=analysis.id;
  document.querySelector('.motion-layout').classList.add('has-report');
  if(!analysis.analysisVersion||analysis.analysisVersion<5){activeMistakeSegments=[];document.querySelector('#analysisResult').innerHTML=`<article class="analysis-report analysis-report--focus"><header><div><span class="eyebrow eyebrow--green">PREVIOUS REPORT FORMAT</span><h2>Reanalyze this video for the fully English report.</h2><p>Older saved reports used a previous language and analysis format, so their technical conclusions are hidden.</p></div><button class="new-analysis-button" id="newAnalysisButton" type="button">Run a New Analysis</button></header><section class="outdated-analysis"><strong>The current version reviews player movement only</strong><p>It checks rotation, balance, stance, lower-body preparation, and swing path from continuous body keypoints.</p></section></article>`;return;}
  const checks=(analysis.checks||[]).map(preciseCheck),good=checks.filter(item=>item.status==='good'),unknown=checks.filter(item=>item.status==='unknown');activeMistakeSegments=(analysis.frames||[]).filter(frame=>frame.mistake!==false).map(frame=>{const linked=checkForFrame(frame,checks);return{...frame,label:frame.label||linked?.label||'Specific movement pattern',time:Number(frame.time)||0,start:Math.max(0,(Number(frame.time)||0)-2),end:(Number(frame.time)||0)+2,check:linked};});activeSegmentEnd=null;
  const checkpoints=activeMistakeSegments.map((item,index)=>`<button type="button" class="error-checkpoint ${index===0?'active':''}" data-error-checkpoint="${index}"><span>${String(index+1).padStart(2,'0')}</span><strong>${escapeHtml(item.label)}</strong><small>${item.time.toFixed(1)} sec</small></button>`).join('');
  const goodText=good.length?`<section class="good-text"><span>WHAT WENT WELL</span><h3>Keep these movement patterns</h3>${good.map(item=>`<p><b>✓ ${escapeHtml(item.label)}</b>${escapeHtml(item.feedback)}</p>`).join('')}</section>`:'';
  const unknownText=unknown.length?`<p class="analysis-unknown">${unknown.map(item=>`${escapeHtml(item.label)}: ${escapeHtml(item.measured)}`).join(' · ')}</p>`:'';
  const focus=activeMistakeSegments.length?`<section class="error-workbench"><div class="error-video"><video id="analysisVideo" src="${escapeHtml(analysis.videoUrl||'')}" controls preload="metadata" playsinline></video><div class="video-moment-label">Evidence windows = separate high-speed movements reviewed across the match</div><div class="error-checkpoints">${checkpoints}</div></div><aside class="error-explanation" id="errorExplanation">${mistakeDetailHtml(activeMistakeSegments[0],0)}</aside></section>`:Number(analysis.movementConfidence)<45?`<section class="no-errors-found pending-contact"><strong>No movement advice generated</strong><p>Body keypoints were not continuous enough. Use a fixed camera and keep the player larger and clearer in frame.</p></section>`:`<section class="no-errors-found"><strong>No movement pattern crossed the review threshold</strong><p>Keep the current stable movement. The report will not invent a problem just to create advice.</p></section>`;
  const planAllowed=Number(analysis.movementConfidence)>=65&&(analysis.exercises||[]).length>0,planHtml=planAllowed?`<div class="analysis-plan-callout"><div><span>Next step</span><strong>Review goals and drills that may help</strong><p>These suggestions come from your body-motion path. Confirm each item before adding it.</p></div><button type="button" id="reviewAnalysisPlan">Review and Confirm →</button></div>`:`<div class="analysis-plan-callout plan-locked"><div><span>NOT ADDED AUTOMATICALLY</span><strong>Treat these observations as a reference</strong><p>Goals and drills are recommended only when movement clarity reaches 65%.</p></div></div>`;
  document.querySelector('#analysisResult').innerHTML=`<article class="analysis-report analysis-report--focus"><header><div><span class="eyebrow eyebrow--green">${escapeHtml(analysis.name||analysis.movementName)} · ${analysis.coverage}% movement coverage</span><h2>${escapeHtml(analysis.overall)}</h2><p>The report first describes visible body movement, then gives a specific improvement direction. It does not detect the ball.</p></div><button class="new-analysis-button" id="newAnalysisButton" type="button">Analyze Another Video</button></header>${confidenceHtml(analysis)}${focus}${goodText}${unknownText}${planHtml}</article>`;
  const video=document.querySelector('#analysisVideo');if(video&&activeMistakeSegments[0]){video.addEventListener('loadedmetadata',()=>{video.currentTime=Math.min(activeMistakeSegments[0].time,video.duration||activeMistakeSegments[0].time);},{once:true});video.addEventListener('timeupdate',()=>{if(activeSegmentEnd!==null&&video.currentTime>=activeSegmentEnd){video.pause();activeSegmentEnd=null;}});}
  const manualVideo=document.querySelector('#manualContactVideo'),manualRange=document.querySelector('#manualContactRange'),manualTime=document.querySelector('#manualContactTime');if(manualVideo&&manualRange&&manualTime){manualVideo.addEventListener('loadedmetadata',()=>{const initial=Math.min(Number(manualVideo.dataset.initialTime)||0,manualVideo.duration||0);manualVideo.currentTime=initial;manualRange.max=String(manualVideo.duration||1);manualRange.value=String(initial);manualTime.textContent=`${initial.toFixed(2)} sec`;},{once:true});manualVideo.addEventListener('timeupdate',()=>{if(!manualRange.matches(':active'))manualRange.value=String(manualVideo.currentTime);manualTime.textContent=`${manualVideo.currentTime.toFixed(2)} sec`;});}
}
function analysisDateLabel(item){const date=new Date(item.createdAt);return Number.isNaN(date.getTime())?'Time not recorded':new Intl.DateTimeFormat('en',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);}
function renderAnalysisHistory() {
  const analyses=currentAccount()?.analyses||[];
  if(analyses.length&&!document.querySelector('#analysisResult .analysis-report'))renderAnalysis(analyses[0]);
  document.querySelector('#analysisHistory').innerHTML=analyses.length?`<div class="analysis-history-head"><div><span>ANALYSIS ARCHIVE</span><h3>Analysis History</h3></div><strong>${analyses.length} ${analyses.length===1?'report':'reports'}</strong></div><div class="analysis-history-list">${analyses.map(item=>`<article class="analysis-history-item"><button type="button" class="analysis-history-main" data-analysis-open="${item.id}"><span>${escapeHtml(item.name||analysisDateLabel(item))}</span><strong>${escapeHtml(analysisDateLabel(item))}</strong></button><div class="analysis-history-actions"><button type="button" data-analysis-rename="${item.id}">Rename</button><button type="button" data-analysis-delete="${item.id}">Delete</button></div></article>`).join('')}</div>`:'';
}

function openCalendarDay(date) {
  const account=currentAccount(); if(!account)return; currentDayContext=date;
  const matches=sortedMatches(account.matches.filter(match=>match.date===date)), scheduled=account.scheduledMatches.filter(item=>item.date===date);
  document.querySelector('#dayTitle').textContent=formatDate(date); let html='';
  if(matches.length)html+=`<section class="day-section"><h3>Matches Logged</h3><div class="real-match-list">${matches.map(matchCard).join('')}</div></section>`;
  if(scheduled.length)html+=`<section class="day-section"><h3>Upcoming Schedule</h3>${scheduled.map(item=>`<article class="day-schedule"><strong>vs ${escapeHtml(item.opponent)}</strong><span>${escapeHtml(englishValue(item.type,'Singles'))}${item.location?` · ${escapeHtml(item.location)}`:''}</span></article>`).join('')}</section>`;
  document.querySelector('#dayContent').innerHTML=html||'<div class="day-empty">No matches or scheduled events on this day.</div>'; document.querySelector('#dayModal').showModal();
}
function openMatchDetail(matchId, fromDay='') {
  const match=currentAccount()?.matches.find(item=>String(item.id)===String(matchId)); if(!match)return;
  currentDetailMatchId=String(match.id); currentDayContext=fromDay;
  document.querySelector('#backToDay').hidden=!fromDay; document.querySelector('#detailTitle').textContent=`vs ${match.opponent}`;
  document.querySelector('#detailMeta').textContent=`${formatDate(match.date)} · ${englishValue(match.matchType,'Singles')} · ${englishValue(match.surface)}`;
  document.querySelector('#detailScore').innerHTML=`<span>${escapeHtml(englishValue(match.result))}</span><strong>${escapeHtml(scoreText(match))}</strong>`;
  document.querySelector('#detailSatisfaction').textContent=satisfactionEmoji(match.satisfaction);
  const note=document.querySelector('#detailNote'); note.hidden=!match.note; note.textContent=match.note||'';
  document.querySelector('#matchDetailModal').showModal();
}
function resetMatchForm() {
  editingMatchId=''; const form=document.querySelector('#matchForm'); form.reset(); document.querySelector('#matchDate').value=localDateValue();
  document.querySelectorAll('.tiebreak-inputs').forEach(row=>row.hidden=true); document.querySelector('#scoreError').hidden=true;
  document.querySelector('#matchSubmitButton').innerHTML='Save Match <span>→</span>'; document.querySelector('#cancelMatchEdit').hidden=true;
}
function editCurrentMatch() {
  const match=currentAccount()?.matches.find(item=>String(item.id)===currentDetailMatchId); if(!match)return; resetMatchForm(); editingMatchId=String(match.id);
  document.querySelector('#opponent').value=match.opponent; document.querySelector('#matchDate').value=match.date; document.querySelector('#surface').value=match.surface;
  document.querySelector(`input[name="matchType"][value="${match.matchType||'Singles'}"]`).checked=true; document.querySelector(`input[name="satisfaction"][value="${satisfactionEmoji(match.satisfaction)}"]`).checked=true; document.querySelector('#matchNote').value=match.note||'';
  const blocks=[...document.querySelectorAll('.set-block')]; match.sets.forEach((set,index)=>{const block=blocks[index];block.querySelector('.player-score').value=set.player;block.querySelector('.opponent-score').value=set.opponent;if(set.tiebreak){block.querySelector('.tiebreak-check').checked=true;block.querySelector('.tiebreak-inputs').hidden=false;block.querySelector('.tiebreak-player').value=set.tiebreak.player;block.querySelector('.tiebreak-opponent').value=set.tiebreak.opponent;}});
  document.querySelector('#matchSubmitButton').innerHTML='Save Changes <span>→</span>'; document.querySelector('#cancelMatchEdit').hidden=false; document.querySelector('#matchDetailModal').close(); showView('new-match');
}
function showScoreError(message){const box=document.querySelector('#scoreError');document.querySelector('#scoreErrorText').textContent=message;box.hidden=false;box.scrollIntoView({behavior:'smooth',block:'center'});}
function collectValidSets(){
  const raw=[...document.querySelectorAll('.set-block')].map((block,index)=>({index,player:block.querySelector('.player-score').value,opponent:block.querySelector('.opponent-score').value,hasTb:block.querySelector('.tiebreak-check').checked,tbPlayer:block.querySelector('.tiebreak-player').value,tbOpponent:block.querySelector('.tiebreak-opponent').value})).filter(s=>s.player!==''||s.opponent!=='');
  if(!raw.length){showScoreError('Enter at least two valid sets.');return null;} if(raw.some((s,i)=>s.index!==i)){showScoreError('Enter each set in order without skipping a set.');return null;} const sets=[];
  for(const set of raw){const label=`Set ${set.index+1}`;if(set.player===''||set.opponent===''){showScoreError(`${label}: enter the game count for both players.`);return null;}const p=Number(set.player),o=Number(set.opponent),high=Math.max(p,o),low=Math.min(p,o),diff=high-low;if(p===o){showScoreError(`${label} cannot end in a tie.`);return null;}if(high<6){showScoreError(`${label} is invalid: the winner needs at least 6 games.`);return null;}if(high===7&&low===6){if(!set.hasTb||set.tbPlayer===''||set.tbOpponent===''){showScoreError(`${label} ended 7–6, so enter both tiebreak scores.`);return null;}const tp=Number(set.tbPlayer),to=Number(set.tbOpponent);if(Math.max(tp,to)<7||Math.abs(tp-to)<2){showScoreError(`${label} tiebreak is invalid: the winner needs at least 7 points and a 2-point lead.`);return null;}if((p>o&&tp<=to)||(o>p&&to<=tp)){showScoreError(`${label}: the tiebreak winner must match the set winner.`);return null;}sets.push({player:String(p),opponent:String(o),tiebreak:{player:String(tp),opponent:String(to)}});}else{if(diff<2){showScoreError(`${label} is invalid: the winner needs at least 6 games and a 2-game lead. A 7–6 set requires a tiebreak score.`);return null;}if(set.hasTb){showScoreError(`${label}: enter a tiebreak score only when the set score is 7–6.`);return null;}sets.push({player:String(p),opponent:String(o)});}}
  let won=0,lost=0;sets.forEach(set=>Number(set.player)>Number(set.opponent)?won++:lost++);if(won<2&&lost<2){showScoreError('In a best-of-three match, one player must win at least two sets.');return null;}return{sets,won,lost};
}

loginForm.addEventListener('submit',async event=>{event.preventDefault();setError('#loginError');const email=document.querySelector('#email').value.trim().toLowerCase(),account=accounts()[email];if(!account||account.passwordHash!==await hashPassword(document.querySelector('#password').value)){setError('#loginError','Incorrect email or password. Create an account first if you are new.');return;}currentEmail=email;openApp();showToast('Signed in');});
document.querySelectorAll('[data-open-login]').forEach(button=>button.addEventListener('click',()=>{setError('#loginError');loginModal.showModal();setTimeout(()=>document.querySelector('#email').focus(),50);}));
document.querySelector('#loginClose').addEventListener('click',()=>loginModal.close());loginModal.addEventListener('click',event=>{if(event.target===loginModal)loginModal.close();});
document.querySelectorAll('[data-open-signup]').forEach(button=>button.addEventListener('click',()=>{setError('#signupError');signupModal.showModal();}));
document.querySelector('#signupButton').addEventListener('click',()=>{setError('#signupError');loginModal.close();signupModal.showModal();});document.querySelector('#signupClose').addEventListener('click',()=>signupModal.close());
document.querySelector('#signupForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,name=document.querySelector('#signupName').value.trim(),email=document.querySelector('#signupEmail').value.trim().toLowerCase(),password=document.querySelector('#signupPassword').value,confirmPassword=document.querySelector('#signupConfirm').value,data=accounts();if(password!==confirmPassword){setError('#signupError','The passwords do not match.');return;}if(data[email]){setError('#signupError','An account already exists for this email. Please sign in.');return;}data[email]={name,email,passwordHash:await hashPassword(password),matches:[],goals:[],scheduledMatches:[],exercises:[],analyses:[],createdAt:new Date().toISOString()};saveAccounts(data);currentEmail=email;signupModal.close();form.reset();openApp();showToast('Account created');});
document.querySelector('#togglePassword').addEventListener('click',event=>{const input=document.querySelector('#password');input.type=input.type==='password'?'text':'password';event.currentTarget.textContent=input.type==='password'?'Show':'Hide';});document.querySelector('#forgotOpen').addEventListener('click',()=>{loginModal.close();forgotModal.showModal();});document.querySelector('#forgotForm .modal-close').addEventListener('click',()=>forgotModal.close());
document.querySelector('#forgotForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,email=document.querySelector('#resetEmail').value.trim().toLowerCase(),data=accounts();if(!data[email]){setError('#resetError','No account was found for this email.');return;}data[email].passwordHash=await hashPassword(document.querySelector('#resetPassword').value);saveAccounts(data);forgotModal.close();form.reset();document.querySelector('#email').value=email;showToast('Password updated');});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();showView(button.dataset.view);}));document.querySelector('#menuButton').addEventListener('click',()=>sidebar.classList.add('open'));document.querySelector('#sidebarClose').addEventListener('click',()=>sidebar.classList.remove('open'));
['#recentMatches','#allMatches'].forEach(selector=>document.querySelector(selector).addEventListener('click',event=>{const card=event.target.closest('[data-match-id]');if(card)openMatchDetail(card.dataset.matchId);}));
document.querySelector('#matchDetailClose').addEventListener('click',()=>document.querySelector('#matchDetailModal').close());document.querySelector('#editMatchButton').addEventListener('click',editCurrentMatch);document.querySelector('#deleteMatchButton').addEventListener('click',()=>{const id=currentDetailMatchId;openConfirm('Delete this match?','The score, reflection, and training suggestions generated from it will be permanently removed.',()=>{updateAccount(account=>{account.matches=account.matches.filter(match=>String(match.id)!==id);account.exercises=account.exercises.filter(item=>String(item.generatedFrom)!==id);});document.querySelector('#matchDetailModal').close();renderData();renderCalendar();renderExercises();if(currentDayContext)openCalendarDay(currentDayContext);showToast('Match deleted');});});
document.querySelector('#backToDay').addEventListener('click',()=>{const date=currentDayContext;document.querySelector('#matchDetailModal').close();openCalendarDay(date);});
document.querySelector('#scheduleToggle').addEventListener('click',()=>{document.querySelector('#scheduleDate').value=localDateValue();document.querySelector('#scheduleModal').showModal();});document.querySelector('#scheduleClose').addEventListener('click',()=>document.querySelector('#scheduleModal').close());document.querySelector('#scheduleForm').addEventListener('submit',event=>{event.preventDefault();const item={id:Date.now(),date:document.querySelector('#scheduleDate').value,opponent:document.querySelector('#scheduleOpponent').value.trim(),type:document.querySelector('#scheduleType').value,location:document.querySelector('#scheduleLocation').value.trim()};updateAccount(account=>account.scheduledMatches.push(item));calendarCursor=new Date(`${item.date}T12:00:00`);event.currentTarget.reset();document.querySelector('#scheduleModal').close();renderCalendar();renderData();showToast('Match added to calendar');});
document.querySelector('#calendarPrev').addEventListener('click',()=>{calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()-1,1);renderCalendar();});document.querySelector('#calendarNext').addEventListener('click',()=>{calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()+1,1);renderCalendar();});document.querySelector('#calendarGrid').addEventListener('click',event=>{const day=event.target.closest('[data-calendar-date]');if(day)openCalendarDay(day.dataset.calendarDate);});document.querySelector('#dayClose').addEventListener('click',()=>document.querySelector('#dayModal').close());document.querySelector('#dayContent').addEventListener('click',event=>{const card=event.target.closest('[data-match-id]');if(!card)return;const date=currentDayContext;document.querySelector('#dayModal').close();openMatchDetail(card.dataset.matchId,date);});
document.querySelector('#goalTitle').addEventListener('input',event=>{const dateInput=document.querySelector('#goalDate'),hint=document.querySelector('#goalDateHint');if(/(?:next|within)\s+(?:the\s+)?4\s+weeks|four[-\s]week/i.test(event.target.value)&&!dateInput.value){dateInput.value=dateAfterDays(28);hint.textContent='Automatically set to four weeks from today';}else if(dateInput.value!==dateAfterDays(28))hint.textContent='';});
document.querySelector('#goalForm').addEventListener('submit',event=>{event.preventDefault();const title=document.querySelector('#goalTitle').value.trim(),date=inferredGoalDate(title,document.querySelector('#goalDate').value);openPlanReview({goal:title,date,exercises:recommendedExercises(title)});});
['#activeGoalList','#completedGoalList'].forEach(selector=>{const list=document.querySelector(selector);list.addEventListener('change',event=>{const input=event.target.closest('[data-goal-check]');if(!input)return;updateAccount(account=>{const goal=account.goals.find(item=>String(item.id)===input.dataset.goalCheck);if(goal)goal.completed=input.checked;});renderGoals();});list.addEventListener('click',event=>{const button=event.target.closest('[data-goal-delete]');if(!button)return;const id=button.dataset.goalDelete;openConfirm('Delete this training goal?','This goal and its progress will be permanently removed.',()=>{updateAccount(account=>account.goals=account.goals.filter(item=>String(item.id)!==id));renderGoals();showToast('Goal deleted');});});});
document.querySelector('#exerciseForm').addEventListener('submit',event=>{event.preventDefault();updateAccount(account=>account.exercises.unshift({id:Date.now(),title:document.querySelector('#exerciseTitle').value.trim(),completed:false}));event.currentTarget.reset();renderExercises();showToast('Drill added');});
document.querySelector('#exerciseExamplesToggle').addEventListener('click',event=>{const examples=document.querySelector('#exerciseExamples');examples.hidden=!examples.hidden;event.currentTarget.textContent=examples.hidden?'Need ideas? View examples':'Hide drill examples';});
document.querySelector('#exerciseExamples').addEventListener('click',event=>{const button=event.target.closest('[data-exercise-example]');if(!button)return;const title=button.dataset.exerciseExample;const exists=(currentAccount()?.exercises||[]).some(item=>item.title===title&&!item.completed);if(exists){showToast('This drill is already in your active list');return;}updateAccount(account=>account.exercises.unshift({id:Date.now(),title,completed:false}));renderExercises();showToast('Drill added');});
['#activeExerciseList','#completedExerciseList'].forEach(selector=>{const list=document.querySelector(selector);list.addEventListener('change',event=>{const input=event.target.closest('[data-exercise-check]');if(!input)return;updateAccount(account=>{const item=account.exercises.find(ex=>String(ex.id)===input.dataset.exerciseCheck);if(item)item.completed=input.checked;});renderExercises();});list.addEventListener('click',event=>{const button=event.target.closest('[data-exercise-delete]');if(!button)return;const id=button.dataset.exerciseDelete;const item=currentAccount()?.exercises.find(exercise=>String(exercise.id)===id);const isSuggestion=Boolean(item?.generatedFrom&&!item.completed);openConfirm(isSuggestion?'Dismiss this training suggestion?':'Delete this drill?',isSuggestion?'This suggestion will be removed from your active drills.':'This drill will be permanently removed.',()=>{updateAccount(account=>account.exercises=account.exercises.filter(exercise=>String(exercise.id)!==id));renderExercises();showToast(isSuggestion?'Suggestion dismissed':'Drill deleted');});});});
document.querySelector('#confirmCancel').addEventListener('click',()=>{pendingConfirmAction=null;document.querySelector('#confirmModal').close();});
document.querySelector('#confirmAccept').addEventListener('click',()=>{const action=pendingConfirmAction;pendingConfirmAction=null;document.querySelector('#confirmModal').close();if(action)action();});
document.querySelector('#confirmModal').addEventListener('cancel',()=>{pendingConfirmAction=null;});
document.querySelector('#planReviewClose').addEventListener('click',closePlanReview);document.querySelector('#planReviewCancel').addEventListener('click',closePlanReview);document.querySelector('#planReviewModal').addEventListener('cancel',()=>{pendingPlan=null;});
document.querySelector('#planReviewConfirm').addEventListener('click',()=>{if(!pendingPlan)return;const plan=pendingPlan;const addGoal=Boolean(document.querySelector('[data-plan-goal]:checked'));const selected=[...document.querySelectorAll('[data-plan-exercise]:checked')].map(input=>plan.exercises[Number(input.dataset.planExercise)]);if(!addGoal&&!selected.length){showToast('Select at least one goal or drill');return;}const goalDate=inferredGoalDate(plan.goal,plan.date);updateAccount(account=>{if(addGoal&&plan.goal&&!account.goals.some(item=>item.title===plan.goal&&!item.completed))account.goals.unshift({id:Date.now(),title:plan.goal,date:goalDate,completed:false,generatedFromAnalysis:plan.analysisId||''});selected.reverse().forEach((title,index)=>{if(!account.exercises.some(item=>item.title===title&&!item.completed))account.exercises.unshift({id:Date.now()+index,title,completed:false,generatedFromAnalysis:plan.analysisId||''});});if(plan.analysisId){const analysis=account.analyses.find(item=>item.id===plan.analysisId);if(analysis)analysis.planAccepted=true;}});document.querySelector('#goalForm').reset();document.querySelector('#goalDateHint').textContent='';closePlanReview();renderGoals();renderExercises();showToast('Added to your training plan');});
async function analyzeSelectedPlayer(candidate){const loading=document.querySelector('#analysisLoading'),button=document.querySelector('#analyzeButton');loading.hidden=false;document.querySelector('#analysisLoadingTitle').textContent='Analyzing the selected player throughout the match';button.disabled=true;setError('#analysisError');try{const response=await fetch('/api/analyze-match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uploadId:pendingVideoAnalysis.uploadId,bbox:candidate.bbox})});const result=await response.json();if(!response.ok)throw new Error(result.error||'The full-match analysis could not be completed.');result.createdAt=new Date().toISOString();result.selectedPlayer=candidate.label;result.uploadId=result.uploadId||pendingVideoAnalysis.uploadId;result.playerBBox=result.playerBBox||candidate.bbox;updateAccount(account=>{account.analyses=account.analyses||[];account.analyses.unshift(result);});renderAnalysis(result);renderAnalysisHistory();document.querySelector('#playerSelection').hidden=true;button.hidden=false;showToast('Full-match analysis complete');}catch(error){setError('#analysisError',error.message||'The full-match analysis could not be completed. Please try again.');}finally{loading.hidden=true;button.disabled=false;}}
document.querySelector('#motionVideo').addEventListener('change',event=>{const file=event.target.files[0],preview=document.querySelector('#motionPreview');if(motionPreviewUrl)URL.revokeObjectURL(motionPreviewUrl);pendingVideoAnalysis=null;document.querySelector('#playerSelection').hidden=true;document.querySelector('#analyzeButton').hidden=false;if(!file){preview.hidden=true;document.querySelector('#motionFileName').textContent='Choose match video';return;}motionPreviewUrl=URL.createObjectURL(file);preview.src=motionPreviewUrl;preview.hidden=false;document.querySelector('#motionFileName').textContent=file.name;setError('#analysisError');});
document.querySelector('#motionForm').addEventListener('submit',async event=>{event.preventDefault();const file=document.querySelector('#motionVideo').files[0];if(!file)return;if(file.size>250*1024*1024){setError('#analysisError','Video must be no larger than 250 MB.');return;}const loading=document.querySelector('#analysisLoading'),button=document.querySelector('#analyzeButton');loading.hidden=false;document.querySelector('#analysisLoadingTitle').textContent='Identifying players in the video';button.disabled=true;setError('#analysisError');const form=new FormData();form.append('video',file);try{const response=await fetch('/api/prepare-analysis',{method:'POST',body:form});const result=await response.json();if(!response.ok)throw new Error(result.error||'Player detection could not be completed.');pendingVideoAnalysis=result;if(result.candidates.length===1){await analyzeSelectedPlayer(result.candidates[0]);return;}document.querySelector('#playerCandidates').innerHTML=result.candidates.map((candidate,index)=>`<label class="player-candidate"><input type="radio" name="selectedPlayer" value="${index}" ${index===0?'checked':''}/><span><img src="${escapeHtml(candidate.thumbnail)}" alt="${escapeHtml(candidate.label)}"/><strong>${escapeHtml(candidate.label)}</strong><small>Player ${index+1}</small></span></label>`).join('');document.querySelector('#playerSelection').hidden=false;button.hidden=true;showToast('Select the player to analyze');}catch(error){setError('#analysisError',error.message||'Player detection could not be completed. Please try again.');}finally{loading.hidden=true;button.disabled=false;}});
document.querySelector('#confirmPlayerButton').addEventListener('click',()=>{const selected=document.querySelector('input[name="selectedPlayer"]:checked');if(!selected||!pendingVideoAnalysis)return;analyzeSelectedPlayer(pendingVideoAnalysis.candidates[Number(selected.value)]);});
document.querySelector('#analysisResult').addEventListener('click',async event=>{const restart=event.target.closest('#newAnalysisButton');if(restart){document.querySelector('.motion-layout').classList.remove('has-report');document.querySelector('#motionForm').reset();document.querySelector('#motionPreview').hidden=true;document.querySelector('#playerSelection').hidden=true;document.querySelector('#analyzeButton').hidden=false;document.querySelector('#motionFileName').textContent='Choose match video';document.querySelector('#analysisResult').innerHTML='<div class="analysis-empty"><span>◎</span><h2>Waiting for a match</h2><p>Your movement windows, observations, and possible improvements will appear here.</p></div>';currentAnalysisId='';activeMistakeSegments=[];return;}const review=event.target.closest('#reviewAnalysisPlan');if(review){const analysis=currentAccount()?.analyses?.find(item=>item.id===currentAnalysisId);if(analysis)openPlanReview({goal:analysis.goal,exercises:analysis.exercises||[],analysisId:analysis.id,message:'These suggestions come from the body-movement patterns visible in your video. Confirm the goal and drills you want to try.'});return;}const checkpoint=event.target.closest('[data-error-checkpoint]');if(checkpoint){const index=Number(checkpoint.dataset.errorCheckpoint),segment=activeMistakeSegments[index],video=document.querySelector('#analysisVideo');document.querySelectorAll('[data-error-checkpoint]').forEach(item=>item.classList.toggle('active',item===checkpoint));document.querySelector('#errorExplanation').innerHTML=mistakeDetailHtml(segment,index);if(video){video.pause();activeSegmentEnd=null;video.currentTime=segment.time;}return;}const freeze=event.target.closest('[data-freeze-error]');if(freeze){const segment=activeMistakeSegments[Number(freeze.dataset.freezeError)],video=document.querySelector('#analysisVideo');if(!video||!segment)return;video.pause();video.playbackRate=1;activeSegmentEnd=null;video.currentTime=segment.time;video.scrollIntoView({behavior:'smooth',block:'center'});return;}const coaching=event.target.closest('[data-open-coaching]');if(coaching){const index=Number(coaching.dataset.openCoaching),segment=activeMistakeSegments[index];if(!segment)return;const coach=coachingFor(segment);document.querySelector('#coachingModalTitle').textContent=coach.title;document.querySelector('#coachingModalChapter').textContent=`${coach.source} · ${coach.chapter}`;document.querySelector('#coachingModalPlayer').innerHTML=`<iframe src="https://www.youtube-nocookie.com/embed/${coach.id}?start=${coach.start}&autoplay=1&rel=0" title="${escapeHtml(coach.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;document.querySelector('#coachingVideoModal').showModal();return;}const play=event.target.closest('[data-play-error]');if(play){const segment=activeMistakeSegments[Number(play.dataset.playError)],video=document.querySelector('#analysisVideo');if(!video)return;video.pause();video.playbackRate=Number(play.dataset.rate)||1;video.currentTime=segment.start;activeSegmentEnd=segment.end;video.play();return;}const openImage=event.target.closest('[data-open-error-image]');if(openImage){const segment=activeMistakeSegments[Number(openImage.dataset.openErrorImage)];document.querySelector('#lightboxImage').src=segment.url;document.querySelector('#lightboxCaption').textContent=`${segment.label} · ${segment.time.toFixed(2)} seconds`;document.querySelector('#imageLightbox').showModal();}});
document.querySelector('#imageLightboxClose').addEventListener('click',()=>document.querySelector('#imageLightbox').close());document.querySelector('#imageLightbox').addEventListener('click',event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
function closeCoachingVideo(){document.querySelector('#coachingVideoModal').close();document.querySelector('#coachingModalPlayer').innerHTML='';}
document.querySelector('#coachingModalClose').addEventListener('click',closeCoachingVideo);document.querySelector('#coachingVideoModal').addEventListener('cancel',event=>{event.preventDefault();closeCoachingVideo();});document.querySelector('#coachingVideoModal').addEventListener('click',event=>{if(event.target===event.currentTarget)closeCoachingVideo();});
function closeAnalysisName(){renamingAnalysisId='';document.querySelector('#analysisNameModal').close();}
document.querySelector('#analysisNameClose').addEventListener('click',closeAnalysisName);document.querySelector('#analysisNameModal').addEventListener('cancel',()=>{renamingAnalysisId='';});document.querySelector('#analysisNameForm').addEventListener('submit',event=>{event.preventDefault();const name=document.querySelector('#analysisNameInput').value.trim();if(!name||!renamingAnalysisId)return;updateAccount(account=>{const analysis=account.analyses.find(item=>item.id===renamingAnalysisId);if(analysis)analysis.name=name;});const renamedId=renamingAnalysisId;closeAnalysisName();renderAnalysisHistory();if(currentAnalysisId===renamedId){const analysis=currentAccount()?.analyses?.find(item=>item.id===renamedId);if(analysis)renderAnalysis(analysis);}showToast('Analysis name saved');});
document.querySelector('#analysisHistory').addEventListener('click',event=>{const open=event.target.closest('[data-analysis-open]');if(open){const analysis=currentAccount()?.analyses?.find(item=>item.id===open.dataset.analysisOpen);if(analysis){renderAnalysis(analysis);document.querySelector('#analysisResult').scrollIntoView({behavior:'smooth',block:'start'});}return;}const rename=event.target.closest('[data-analysis-rename]');if(rename){const analysis=currentAccount()?.analyses?.find(item=>item.id===rename.dataset.analysisRename);if(!analysis)return;renamingAnalysisId=analysis.id;document.querySelector('#analysisNameInput').value=analysis.name||analysisDateLabel(analysis);document.querySelector('#analysisNameModal').showModal();document.querySelector('#analysisNameInput').select();return;}const remove=event.target.closest('[data-analysis-delete]');if(remove){const id=remove.dataset.analysisDelete;openConfirm('Delete this video analysis?','The report, movement frames, and improvement suggestions will be permanently removed from your analysis history.',()=>{updateAccount(account=>account.analyses=account.analyses.filter(item=>item.id!==id));if(currentAnalysisId===id){currentAnalysisId='';activeMistakeSegments=[];document.querySelector('.motion-layout').classList.remove('has-report');document.querySelector('#analysisResult').innerHTML='<div class="analysis-empty"><span>◎</span><h2>Waiting for a match</h2><p>Upload a video to create a new movement analysis.</p></div>';}renderAnalysisHistory();showToast('Analysis deleted');});}});
document.querySelector('#logoutButton').addEventListener('click',()=>{currentEmail='';sessionStorage.removeItem('tennis-current-user');appShell.hidden=true;loginPage.hidden=false;loginForm.reset();window.scrollTo({top:0,behavior:'auto'});});
document.querySelectorAll('.tiebreak-check').forEach(input=>input.addEventListener('change',()=>{const row=input.closest('.set-block').querySelector('.tiebreak-inputs');row.hidden=!input.checked;if(!input.checked)row.querySelectorAll('input').forEach(field=>field.value='');}));document.querySelector('#cancelMatchEdit').addEventListener('click',()=>{resetMatchForm();showView('overview');});
document.querySelector('#matchForm').addEventListener('submit',event=>{event.preventDefault();const valid=collectValidSets();if(!valid)return;const wasEditing=Boolean(editingMatchId);const editId=editingMatchId;const note=document.querySelector('#matchNote').value.trim();const id=editId||String(Date.now());const match={id:Number(id),opponent:document.querySelector('#opponent').value.trim(),date:document.querySelector('#matchDate').value,surface:document.querySelector('#surface').value,sets:valid.sets,matchType:document.querySelector('input[name="matchType"]:checked').value,satisfaction:document.querySelector('input[name="satisfaction"]:checked').value,note,result:valid.won>valid.lost?'Win':'Loss'};let suggestions=0;updateAccount(account=>{if(wasEditing){const index=account.matches.findIndex(item=>String(item.id)===editId);if(index>=0)account.matches[index]=match;}else account.matches.push(match);suggestions=generateExercises(note,match.id,account);});resetMatchForm();renderData();renderCalendar();renderExercises();showView('overview');showToast(wasEditing?'Match updated':suggestions?`Match saved and ${suggestions} training ${suggestions===1?'suggestion was':'suggestions were'} created`:'Match saved');openMatchDetail(match.id);});

document.querySelector('#matchDate').value=localDateValue();document.querySelector('#scheduleDate').min=localDateValue();document.querySelector('#goalDate').min=localDateValue();
async function initializeApp() {
  try {
    const response = await fetch('/api/accounts', {cache:'no-store'});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not read the database');
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
    setError('#loginError',error.message || 'Could not connect to the website database. Please check the server.');
  }
}
initializeApp();
