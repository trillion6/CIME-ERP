/* ============================================================
   DATA MODEL & CONFIG
============================================================ */
const API_URL = (window.COHORT_CONFIG && window.COHORT_CONFIG.apiUrl) || 'https://cime-backend.onrender.com/api';
const SUBJECTS = ['Database Systems', 'Java Programming', 'Data Structures', 'Web Development', 'Computer Networks'];
const DEPARTMENTS = ['MCA', 'MBA'];
const SEMESTERS = ['Semester 1', 'Semester 2', 'Semester 3', 'Semester 4', 'Semester 5', 'Semester 6'];
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#6d5df6,#46a0fc)',
  'linear-gradient(135deg,#1fcfa8,#63e6c4)',
  'linear-gradient(135deg,#ff6b81,#ffa07a)',
  'linear-gradient(135deg,#ffb648,#ffd76b)',
  'linear-gradient(135deg,#a06df6,#f646d1)',
  'linear-gradient(135deg,#46c6fc,#46f6d5)'
];

function tokenPayload(token){
  if(!token) return null;
  try {
    const part = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const json = decodeURIComponent(Array.prototype.map.call(atob(part), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json);
  } catch(e){ return null; }
}
function roleFromToken(token){ const p = tokenPayload(token); return (p && p.role) || 'user'; }

let state = {
  students: [],
  editingId: null,
  deletingId: null,
  currentStatus: 'active',
  attendanceDate: todayISO(),
  currentDrawerId: null,
  role: 'user',
  token: localStorage.getItem('token') || sessionStorage.getItem('token') || null,
  currentUserId: null,
  users: [],
  page: 1,
  pageSize: 10,
  pageTotal: 0,
  pageStudents: [],
  resetUserId: null,
  userName: localStorage.getItem('userName') || '',
  userEmail: localStorage.getItem('userEmail') || ''
};
state.role = state.token ? roleFromToken(state.token) : 'user';
state.currentUserId = state.token ? (tokenPayload(state.token) || {}).id : null;

function localDateStr(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayISO(){ return localDateStr(new Date()); }
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function hashPick(arr, seed){
  let h = 0; for(const c of seed) h = (h*31 + c.charCodeAt(0)) % 100000;
  return arr[h % arr.length];
}
function initials(name){ return name.split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase(); }
function letterGrade(score){
  if(score>=90) return 'A'; if(score>=80) return 'B'; if(score>=70) return 'C'; if(score>=60) return 'D'; return 'F';
}
function gradeColor(letter){
  return {A:'var(--grad-mint)',B:'var(--grad-primary)',C:'var(--grad-amber)',D:'linear-gradient(135deg,#ff9f43,#ffb648)',F:'var(--grad-coral)'}[letter];
}
function dateMinus(n){
  const d = new Date(); d.setDate(d.getDate()-n); return localDateStr(d);
}

/* ============================================================
   GLOBAL LOADER & API CALLS
============================================================ */
const toggleLoader = (show) => {
    document.getElementById('globalLoader').style.display = show ? 'flex' : 'none';
};

async function apiCall(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    
    const response = await fetch(`${API_URL}${endpoint}`, options);
    const data = await response.json();
    
    if (response.status === 401) {
        // Token missing, expired or invalid — return to the login screen
        localStorage.removeItem('token');
        sessionStorage.removeItem('token');
        state.token = null;
        location.reload();
    }
    
    if (!response.ok) throw new Error(data.error || 'API Error');
    return data;
}

/* ============================================================
   ICONS (inline helpers)
============================================================ */
const ICO = {
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  grad:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5-10-5Z"/><path d="M6 12v5c0 1.5 2.5 3 6 3s6-1.5 6-3v-5"/></svg>',
  key:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
};

/* ============================================================
   AUTH & THEME
============================================================ */
async function handleLogin(e) {
  e.preventDefault();
  const loginBtn = document.getElementById('loginSubmitBtn');
  if(loginBtn){ loginBtn.disabled = true; loginBtn.innerHTML = 'Signing in…'; }
  toggleLoader(true);
  try {
      const email = document.getElementById('loginEmail').value;
      const pass = document.getElementById('loginPass').value;
      
      const data = await apiCall('/auth/login', 'POST', { email, password: pass });
      
      state.token = data.token;
      state.role = data.role;
      state.currentUserId = data.id;
      state.userName = data.name || '';
      state.userEmail = data.email || '';
      if(document.getElementById('rememberMe').checked){
        localStorage.setItem('token', data.token);
        localStorage.setItem('userName', state.userName);
        localStorage.setItem('userEmail', state.userEmail);
      } else {
        sessionStorage.setItem('token', data.token);
      }
      
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('mainApp').style.display = 'flex';
      
      initApp();
  } catch (err) {
      showToast(err.message, 'error');
      // Unverified account → surface the "check your email / resend link" notice
      if(err.message && /verify your email/i.test(err.message)){
        showVerifyNotice(document.getElementById('loginEmail').value.trim());
      }
  } finally {
      toggleLoader(false);
      if(loginBtn){ loginBtn.disabled = false; loginBtn.innerHTML = 'Login to ERP'; }
  }
}

/* Verification dead-end helper: tell the user where the link went + let them resend */
function showVerifyNotice(email){
  const box = document.getElementById('verifyNotice');
  if(!box) return;
  const emailLabel = document.getElementById('verifyNoticeEmail');
  const input = document.getElementById('verifyNoticeEmailInput');
  if(emailLabel) emailLabel.textContent = email || 'your account';
  if(input) input.value = email || '';
  box.style.display = '';
}
async function resendVerificationLink(){
  const email = document.getElementById('verifyNoticeEmailInput').value.trim();
  if(!email){ showToast('Enter your email address.', 'error'); return; }
  toggleLoader(true);
  try {
    await apiCall('/auth/resend-verification', 'POST', { email });
    showToast('If the account is unverified, a fresh verification link was sent.', 'info');
  } catch(err){ showToast(err.message, 'error'); }
  finally { toggleLoader(false); }
}

/* Sign In / Create Account tabs */
function switchAuthTab(tab){
  // The taller Create Account form gets more room — the banner tucks up (CSS body.signup-open)
  document.body.classList.toggle('signup-open', tab === 'signup');
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('loginFormWrap').style.display = tab === 'signin' ? '' : 'none';
  document.getElementById('signupFormWrap').style.display = tab === 'signup' ? '' : 'none';
  // Fresh state every time the tab is opened
  const form = document.getElementById('signupForm');
  const success = document.getElementById('signupSuccess');
  if(form) form.style.display = '';
  if(success) success.style.display = 'none';
  ['su_name','su_email','su_password','su_confirm'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.classList.remove('invalid');
  });
  ['su_name_error','su_email_error','su_pw_error','su_cf_error'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.style.display = 'none';
  });
  const meter = document.getElementById('su_pw_meter');
  if(meter) meter.style.display = 'none';
  const hint = document.getElementById('su_pw_hint');
  if(hint) hint.remove();
}

/* Field-level validation helpers */
function setFieldError(inputId, errorId, hasError){
  const input = document.getElementById(inputId);
  const err = document.getElementById(errorId);
  if(input) input.classList.toggle('invalid', hasError);
  if(err) err.style.display = hasError ? '' : 'none';
}
function togglePassword(inputId, btn){
  const input = document.getElementById(inputId);
  if(!input) return;
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  if(btn) btn.classList.toggle('visible', !visible);
}
function updatePwStrength(){
  const pw = document.getElementById('su_password');
  const meter = document.getElementById('su_pw_meter');
  const bar = document.getElementById('su_pw_bar');
  if(!pw || !meter || !bar) return;
  // Typing replaces the submit-time error with the live meter feedback
  setFieldError('su_password', 'su_pw_error', false);
  pw.classList.remove('invalid');
  const len = pw.value.length;
  if(len === 0){
    meter.style.display = 'none';
    const hint = document.getElementById('su_pw_hint');
    if(hint) hint.remove();
    return;
  }
  meter.style.display = '';
  const cls = len < 6 ? 'weak' : (len < 10 ? 'fair' : 'strong');
  bar.className = 'pw-bar ' + cls;
  let hint = document.getElementById('su_pw_hint');
  if(!hint){
    hint = document.createElement('div');
    hint.id = 'su_pw_hint';
    meter.insertAdjacentElement('afterend', hint);
  }
  hint.className = 'pw-meter-hint ' + cls;
  hint.textContent = len < 6 ? 'Too short — minimum 6 characters' : (len < 10 ? 'Good strength' : 'Strong password');
}

document.getElementById('su_password').addEventListener('input', updatePwStrength);
['su_name','su_email','su_confirm'].forEach(id=>{
  document.getElementById(id).addEventListener('input', (e)=>{
    e.target.classList.remove('invalid');
    if(id === 'su_confirm') setFieldError('su_confirm', 'su_cf_error', false);
  });
});

/* Public self-registration — the account is created but requires email verification */
async function handleSignup(e){
  e.preventDefault();
  const name = document.getElementById('su_name').value.trim();
  const email = document.getElementById('su_email').value.trim();
  const pw = document.getElementById('su_password').value;
  const cf = document.getElementById('su_confirm').value;
  const nameOk = !!name;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const pwOk = pw.length >= 6;
  const cfOk = pw === cf;
  setFieldError('su_name', 'su_name_error', !nameOk);
  setFieldError('su_email', 'su_email_error', !emailOk);
  setFieldError('su_password', 'su_pw_error', !pwOk);
  setFieldError('su_confirm', 'su_cf_error', !cfOk);
  if(!nameOk || !emailOk || !pwOk || !cfOk) return;
  toggleLoader(true);
  const btn = document.getElementById('signupSubmitBtn');
  if(btn){ btn.disabled = true; btn.innerHTML = 'Creating account…'; }
  try {
    const data = await apiCall('/auth/register', 'POST', { name, email, password: pw });
    // Account created — show the "check your email" success state (no auto-login)
    document.getElementById('signupSuccessEmail').textContent = data.email || email;
    document.getElementById('signupForm').style.display = 'none';
    document.getElementById('signupSuccess').style.display = '';
    showToast('Account created — check your email to verify it.', 'success');
  } catch(err){ showToast(err.message, 'error'); }
  finally {
    toggleLoader(false);
    if(btn){ btn.disabled = false; btn.innerHTML = 'Create Account'; }
  }
}

function handleLogout() {
    localStorage.removeItem('token');
    localStorage.removeItem('userName');
    localStorage.removeItem('userEmail');
    sessionStorage.removeItem('token');
    state.token = null;
    location.reload();
}

/* Reflect the signed-in user's name/initials in the sidebar + topbar */
function updateUserDisplay(){
  const name = state.userName || (state.token ? 'User' : '');
  const el = document.getElementById('userNameDisplay');
  if(el) el.textContent = name || 'User';
  const initialsEl = document.getElementById('userAvatarInitials');
  if(initialsEl) initialsEl.textContent = initials(name || 'U');
  const topbarEl = document.getElementById('topbarAvatar');
  if(topbarEl) topbarEl.textContent = initials(name || 'U');
}

/* --- Theme picker: light / dark / system + accent --- */
let themePref = localStorage.getItem('theme') || 'light';
let accentPref = localStorage.getItem('accent') || 'violet';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const resolveTheme = pref => pref === 'system' ? (systemDark.matches ? 'dark' : 'light') : pref;

const ACCENTS = {
  violet:  { primary: '#6d5df6', secondary: '#ffb648' },
  emerald: { primary: '#0ca678', secondary: '#94d82d' },
  sunset:  { primary: '#e8590c', secondary: '#f76707' },
  ocean:   { primary: '#1971c2', secondary: '#1098ad' }
};
const accentColors = () => ACCENTS[accentPref] || ACCENTS.violet;
function hexToRgba(hex, a){
  const n = parseInt(hex.replace('#',''), 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}

function refreshCharts(){
  if(typeof attendanceChartInst !== 'undefined' && attendanceChartInst) renderAttendanceChart();
  if(typeof deptChartInst !== 'undefined' && deptChartInst) renderDeptChart();
}
function applyTheme(pref){
  themePref = pref;
  localStorage.setItem('theme', pref);
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  renderThemeMenu();
  refreshCharts();
}
function applyAccent(acc){
  accentPref = acc;
  localStorage.setItem('accent', acc);
  document.documentElement.setAttribute('data-accent', acc);
  renderThemeMenu();
  refreshCharts();
}
function renderThemeMenu(){
  document.querySelectorAll('.theme-option').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === themePref));
  document.querySelectorAll('.accent-option').forEach(b => b.classList.toggle('active', b.dataset.accentOpt === accentPref));
}

/* Build dropdown content (topbar + login page) from data */
function buildThemeMenu(menuEl){
  if(!menuEl) return;
  menuEl.innerHTML = `
    <div class="theme-menu-label">Theme</div>
    ${['light','dark','system'].map(m => `<button class="theme-option" data-theme-opt="${m}" onclick="applyTheme('${m}')"><span class="theme-swatch ${m}-swatch"></span>${m[0].toUpperCase()+m.slice(1)}</button>`).join('')}
    <div class="theme-menu-label">Accent</div>
    <div class="accent-row">${Object.entries(ACCENTS).map(([k,v]) => `<button class="accent-option" data-accent-opt="${k}" onclick="applyAccent('${k}')" title="${k[0].toUpperCase()+k.slice(1)}"><span class="accent-dot" style="background:${v.primary}"></span></button>`).join('')}</div>`;
}
function buildThemeControls(){
  buildThemeMenu(document.getElementById('themeMenu'));
}

/* Institution settings (admin) — persisted locally, defaults restored via Reset */
const INST_DEFAULTS = {
  inst_name: 'College of IT and Management Education (CIME)',
  inst_year: '2026 – 2027',
  inst_tz: 'Asia/Kolkata',
  inst_email: 'admin@cime.edu'
};
/* Auto-grow the institution-name textarea so it matches single-line inputs
   when short, and only expands when the text wraps to more lines. */
function autoGrowTextarea(el){
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(45, el.scrollHeight) + 'px';
}
function loadInstitutionSettings(){
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('institution') || '{}'); } catch(e){}
  Object.keys(INST_DEFAULTS).forEach(id => {
    const el = document.getElementById(id);
    if(el) el.value = (saved[id] != null ? saved[id] : INST_DEFAULTS[id]);
    if(id === 'inst_name') autoGrowTextarea(el);
  });
}
function saveInstitution(){
  const data = {};
  Object.keys(INST_DEFAULTS).forEach(id => {
    const el = document.getElementById(id);
    if(el) data[id] = el.value.trim();
  });
  if(!data.inst_name){ showToast('Institution name is required.', 'error'); return; }
  localStorage.setItem('institution', JSON.stringify(data));
  showToast('Institution settings saved.', 'success');
}
function resetInstitution(){
  localStorage.removeItem('institution');
  loadInstitutionSettings();
  showToast('Institution settings reset to defaults.', 'info');
}

function closeThemeMenu(){ document.querySelectorAll('.theme-menu').forEach(m => m.classList.remove('open')); }
function toggleThemeMenu(id, e){
  e.stopPropagation();
  const m = document.getElementById(id);
  const willOpen = !m.classList.contains('open');
  closeThemeMenu();
  if(willOpen) m.classList.add('open');
}
document.getElementById('themeToggleBtn').addEventListener('click', e => toggleThemeMenu('themeMenu', e));
document.querySelectorAll('.theme-menu').forEach(m => m.addEventListener('click', e => e.stopPropagation()));

/* Login banner: subtle parallax on the decorative layers as the mouse moves */
(function(){
  const banner = document.querySelector('.cime-banner');
  if(!banner) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduced) return;
  // Note: .cb-hex is excluded — its cbFloat animation owns `transform`, so parallax would never apply.
  const layers = banner.querySelectorAll('.cb-globe, .cb-neural');
  if(!layers.length) return;
  banner.addEventListener('pointermove', (e) => {
    const r = banner.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    layers.forEach((el, i) => {
      const depth = 10 + (i * 6);
      el.style.transform = `translate(${(-nx * depth).toFixed(1)}px, ${(-ny * depth).toFixed(1)}px)`;
    });
  });
  banner.addEventListener('pointerleave', () => {
    layers.forEach(el => el.style.transform = '');
  });
})();
document.addEventListener('click', closeThemeMenu);
systemDark.addEventListener('change', () => {
  if(themePref === 'system') document.documentElement.setAttribute('data-theme', resolveTheme('system'));
});

// Apply saved preferences on load (charts don't exist yet — renderThemeMenu + builders only)
document.documentElement.setAttribute('data-theme', resolveTheme(themePref));
document.documentElement.setAttribute('data-accent', accentPref);
buildThemeControls();
renderThemeMenu();
loadInstitutionSettings(); // sync the login banner with saved institution details


/* ============================================================
   RENDER: NAVIGATION
============================================================ */
document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.addEventListener('click', ()=> switchView(btn.dataset.view));
});
function switchView(view){
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active', v.id === 'view-'+view));
  closeSidebarMobile();
  if(view==='reports') renderReports();
  if(view==='students') fetchStudentsPage();
  if(view==='users'){ fetchAudit(); fetchUsers(); }
  window.scrollTo({top:0,behavior:'smooth'});
}
document.getElementById('hamburgerBtn').addEventListener('click', ()=>{
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('open');
});
document.getElementById('sidebarOverlay').addEventListener('click', closeSidebarMobile);
function closeSidebarMobile(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

/* ============================================================
   FETCH DATA
============================================================ */
async function fetchStudents() {
    try {
        state.students = await apiCall('/students');
        
        // Setup initial default attributes for fetched objects if missing (like grades/attendance dicts)
        state.students = state.students.map(s => ({
            ...s, 
            grades: s.grades || {},
            attendance: s.attendance || {}
        }));
        
        renderDashboard();
        renderAttendanceView();
        renderResultsView();
    } catch(err) {
        showToast('Failed to load students', 'error');
    }
}


/* ============================================================
   DASHBOARD
============================================================ */
let attendanceChartInst=null, deptChartInst=null;

function computeStats(){
  const mcaStudents = state.students.filter(s=>s.department==='MCA');
  const mbaStudents = state.students.filter(s=>s.department==='MBA');
  const totalMCA = mcaStudents.length;
  const totalMBA = mbaStudents.length;
  
  let mcaAttToday = 0;
  mcaStudents.forEach(s=>{
    const rec = s.attendance[state.attendanceDate];
    if(rec==='present') mcaAttToday++;
  });
  
  let mbaAttToday = 0;
  mbaStudents.forEach(s=>{
    const rec = s.attendance[state.attendanceDate];
    if(rec==='present') mbaAttToday++;
  });
  
  return {totalMCA, totalMBA, mcaAttToday, mbaAttToday};
}

function renderStatCards(){
  const st = computeStats();
  const grid = document.getElementById('statGrid');
  const cards = [
    {label:'Total MCA Students', value: st.totalMCA, icon:ICO.users, grad:'var(--grad-primary)', trend:'MCA Program', up:true},
    {label:'Total MBA Students', value: st.totalMBA, icon:ICO.users, grad:'var(--grad-amber)', trend:'MBA Program', up:true},
    {label:"MCA Attendance Today", value: st.mcaAttToday, icon:ICO.cal, grad:'var(--grad-mint)', trend: 'Present Today', up: true},
    {label:"MBA Attendance Today", value: st.mbaAttToday, icon:ICO.cal, grad:'var(--grad-coral)', trend: 'Present Today', up:true},
  ];
  grid.innerHTML = cards.map(c=>`
    <div class="card stat-card" style="--accent-grad:${c.grad}">
      <div class="stat-top">
        <div class="stat-icon" style="background:${c.grad}">${c.icon}</div>
        <span class="stat-trend ${c.up?'trend-up':'trend-down'}">${c.trend}</span>
      </div>
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>
  `).join('');
  document.getElementById('navStudentCount').textContent = state.students.length;
}

function renderAttendanceChart(){
  const ctx = document.getElementById('attendanceChart');
  if(typeof Chart === 'undefined') return; // charts are optional — don't break the dashboard if Chart.js is unavailable
  const labels = []; const data = [];
  for(let i=6;i>=0;i--){
    const d = dateMinus(i);
    labels.push(new Date(d).toLocaleDateString('en-US',{weekday:'short'}));
    let present=0, total=0;
    state.students.forEach(s=>{ const r=s.attendance[d]; if(r){total++; if(r==='present') present++;} });
    data.push(total? Math.round(present/total*100) : 0);
  }
  
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(28,32,51,0.06)';
  const textColor = isDark ? '#9aa1b5' : '#6b7280';
  
  const accent = accentColors();
  if(attendanceChartInst) attendanceChartInst.destroy();
  attendanceChartInst = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{
      label:'Attendance %', data,
      borderColor: accent.primary, borderWidth:3, tension:0.4, fill:true,
      backgroundColor: (c)=>{
        const g = c.chart.ctx.createLinearGradient(0,0,0,220);
        g.addColorStop(0, hexToRgba(accent.primary, 0.28)); g.addColorStop(1, hexToRgba(accent.primary, 0.02));
        return g;
      },
      pointBackgroundColor:'#fff', pointBorderColor: accent.primary, pointBorderWidth:2, pointRadius:5, pointHoverRadius:7
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}, tooltip:{backgroundColor:'#1c2033', padding:10, cornerRadius:10, displayColors:false}},
      scales:{
        y:{min:0,max:100,grid:{color:gridColor}, ticks:{callback:v=>v+'%', color:textColor, font:{size:11}}},
        x:{grid:{display:false}, ticks:{color:textColor, font:{size:11,weight:600}}}
      }
    }
  });
}

function renderDeptChart(){
  const ctx = document.getElementById('deptChart');
  if(typeof Chart === 'undefined') return; // charts are optional — don't break the dashboard if Chart.js is unavailable
  const buckets = {MCA:0, MBA:0};
  state.students.forEach(s=>{ buckets[s.department]++; });
  const accent = accentColors();
  const colors = {MCA: accent.primary, MBA: accent.secondary};
  if(deptChartInst) deptChartInst.destroy();
  deptChartInst = new Chart(ctx, {
    type:'doughnut',
    data:{ labels:Object.keys(buckets), datasets:[{ data:Object.values(buckets), backgroundColor:Object.keys(buckets).map(k=>colors[k]), borderWidth:0, hoverOffset:6 }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:'68%', plugins:{legend:{display:false}, tooltip:{backgroundColor:'#1c2033', padding:10, cornerRadius:10}} }
  });
  document.getElementById('deptLegend').innerHTML = Object.keys(buckets).map(k=>`
    <div class="legend-item"><span class="legend-dot" style="background:${colors[k]}"></span>${k} Department · ${buckets[k]} Students</div>
  `).join('');
}

function studentAvgGrade(s){
  if(!s.grades) return 0;
  const vals = SUBJECTS.map(su=>s.grades[su] || 0);
  return Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
}
function studentAttendanceRate(s){
  if(!s.attendance) return 0;
  const entries = Object.values(s.attendance);
  if(!entries.length) return 0;
  const present = entries.filter(v=>v==='present').length;
  return Math.round(present/entries.length*100);
}

function renderRecentStudents(){
  const recent = [...state.students].sort((a,b)=> (b.enroll_date||'').localeCompare(a.enroll_date||'')).slice(0,5);
  document.getElementById('recentStudentsList').innerHTML = recent.map(s=>personRowHTML(s, true)).join('') || emptyRow();
}

function emptyRow(){ return `<div class="empty-state"><p>No data found.</p></div>`; }

function personRowHTML(s, compact){
  const avg = studentAvgGrade(s);
  const letter = letterGrade(avg);
  return `
  <div class="person-row" data-id="${s.id}">
    <div class="avatar" style="background:${esc(s.avatar) || 'var(--grad-primary)'}">${initials(s.name)}</div>
    <div class="person-info">
      <div class="person-name">${esc(s.name)}</div>
      <div class="person-meta">${esc(s.email)}</div>
    </div>
    <span class="pill pill-class">${esc(s.department)} · ${esc(s.semester)}</span>
    ${compact? '' : `<span class="pill ${s.status==='active'?'pill-active':'pill-inactive'}">${esc(s.status)}</span>`}
    <div class="grade-badge" style="background:${gradeColor(letter)}" title="Average ${avg}%">${letter}</div>
    <div class="row-actions">
      <button class="icon-btn-sm" title="View" onclick="openDrawer('${s.id}')">${ICO.eye}</button>
      <button class="icon-btn-sm" title="Edit" onclick="openStudentModal('${s.id}')">${ICO.edit}</button>
      <button class="icon-btn-sm danger" title="Delete" onclick="openDeleteModal('${s.id}')">${ICO.trash}</button>
    </div>
  </div>`;
}

function renderDashboard(){
  document.getElementById('dateLine').textContent = new Date().toLocaleDateString('en-US',{weekday:'long', year:'numeric', month:'long', day:'numeric'});
  renderStatCards();
  renderAttendanceChart();
  renderDeptChart();
  renderRecentStudents();
}

/* ============================================================
   STUDENTS VIEW
============================================================ */
function populateFilters(){
  const deptOpts = '<option value="">All Departments</option>' + DEPARTMENTS.map(d=>`<option value="${d}">${d}</option>`).join('');
  const semOpts = '<option value="">All Semesters</option>' + SEMESTERS.map(s=>`<option value="${s}">${s}</option>`).join('');

  document.getElementById('deptFilter').innerHTML = deptOpts;
  document.getElementById('semFilter').innerHTML = semOpts;

  document.getElementById('attDeptFilter').innerHTML = deptOpts.replace('All Departments','Select Department');
  document.getElementById('attSemFilter').innerHTML = semOpts.replace('All Semesters','Select Semester');

  document.getElementById('resDeptFilter').innerHTML = deptOpts;
  document.getElementById('resSemFilter').innerHTML = semOpts;
  document.getElementById('resSubjectFilter').innerHTML = SUBJECTS.map(s=>`<option value="${s}">${s}</option>`).join('');
}

/* --- Server-side paginated student list --- */
function studentsPageQuery(){
  const params = new URLSearchParams({ page: state.page, limit: state.pageSize });
  const q = document.getElementById('studentSearch').value;
  const dept = document.getElementById('deptFilter').value;
  const sem = document.getElementById('semFilter').value;
  const status = document.getElementById('statusFilter').value;
  if(q) params.set('q', q);
  if(dept) params.set('department', dept);
  if(sem) params.set('semester', sem);
  if(status) params.set('status', status);
  return params.toString();
}

let pageRequestSeq = 0; // guards against stale/out-of-order responses

async function fetchStudentsPage(){
  const seq = ++pageRequestSeq;
  try {
    const res = await apiCall('/students?' + studentsPageQuery());
    if(seq !== pageRequestSeq) return; // a newer request is in flight — ignore this one
    state.pageStudents = res.data || [];
    state.pageTotal = res.total || 0;
    // Clamp the page if the result set shrank (e.g. after a delete/filter change)
    const totalPages = Math.max(1, Math.ceil(state.pageTotal / state.pageSize));
    if(state.page > totalPages){ state.page = totalPages; fetchStudentsPage(); return; }
    renderStudentsPage();
  } catch(err){
    if(seq !== pageRequestSeq) return;
    showToast(err.message, 'error');
  }
}

function renderStudentsPage(){
  const list = state.pageStudents;
  const container = document.getElementById('studentsList');
  const empty = document.getElementById('studentsEmpty');
  if(!list.length){ container.innerHTML=''; empty.style.display='block'; }
  else { empty.style.display='none'; container.innerHTML = list.map(s=>personRowHTML(s,false)).join(''); }
  const start = (state.page-1)*state.pageSize + 1;
  const end = Math.min((state.page-1)*state.pageSize + list.length, state.pageTotal);
  document.getElementById('studentsPageInfo').textContent = state.pageTotal
    ? `Showing ${start}–${end} of ${state.pageTotal}`
    : 'No students found';
  document.getElementById('studentsPrevBtn').disabled = state.page <= 1;
  document.getElementById('studentsNextBtn').disabled = state.page >= Math.ceil(state.pageTotal / state.pageSize);
}

function studentsPrev(){ state.page = Math.max(1, state.page-1); fetchStudentsPage(); }
function studentsNext(){ state.page += 1; fetchStudentsPage(); }

function debounce(fn, ms){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }

document.getElementById('studentSearch').addEventListener('input', debounce(()=>{ state.page=1; fetchStudentsPage(); }, 300));
['deptFilter','semFilter','statusFilter'].forEach(id=>{
  document.getElementById(id).addEventListener('change', ()=>{ state.page=1; fetchStudentsPage(); });
});
document.getElementById('globalSearch').addEventListener('input', (e)=>{
  document.getElementById('studentSearch').value = e.target.value;
  switchView('students');
});

/* Phone helpers: keep the field sane while typing + validate on submit */
function sanitizePhone(input){
  if(!input) return;
  // Digits, spaces, dashes and a single leading '+' only
  let v = input.value.replace(/[^\d+\s-]/g, '');
  // Collapse repeated '+' signs down to the leading one
  v = v.replace(/\+/g, (m, i) => (i === 0 ? m : ''));
  // Hard cap: optional country code (up to 3 digits) + exactly 10 local digits
  let digitsSeen = 0;
  v = Array.from(v).filter(ch => {
    if(/\d/.test(ch)){
      if(digitsSeen >= 13) return false;
      digitsSeen++;
    }
    return true;
  }).join('');
  v = v.replace(/^\s+|\s+$/g, ''); // no leading/trailing whitespace
  input.value = v;
  input.classList.remove('invalid');
  const err = document.getElementById('f_phone_error');
  if(err) err.style.display = 'none';
}
function isValidPhone(phone){
  if(!phone || !String(phone).trim()) return true; // optional field
  const norm = String(phone).replace(/[\s-]/g, '');
  return /^(\+\d{1,3})?\d{10}$/.test(norm);
}

/* Student modal */
function openStudentModal(id){
  state.editingId = id || null;
  const backdrop = document.getElementById('studentModalBackdrop');
  document.getElementById('studentModalTitle').textContent = id ? 'Edit Student' : 'Add Student';
  if(id){
    const s = state.students.find(x=>x.id===id);
    document.getElementById('f_name').value = s.name;
    document.getElementById('f_email').value = s.email;
    document.getElementById('f_phone').value = s.phone || '';
    document.getElementById('f_gender').value = s.gender;
    document.getElementById('f_dept').value = s.department;
    document.getElementById('f_sem').value = s.semester;
    document.getElementById('f_enroll').value = s.enroll_date || todayISO();
    setStatus(s.status);
  } else {
    document.getElementById('studentForm').reset();
    document.getElementById('f_enroll').value = todayISO();
    setStatus('active');
  }
  document.getElementById('f_phone').classList.remove('invalid');
  const err = document.getElementById('f_phone_error');
  if(err) err.style.display = 'none';
  backdrop.classList.add('open');
  setTimeout(()=>document.getElementById('f_name').focus(), 50);
}
function closeStudentModal(){ document.getElementById('studentModalBackdrop').classList.remove('open'); }
function setStatus(s){
  state.currentStatus = s;
  document.getElementById('statusActiveBtn').classList.toggle('selected', s==='active');
  document.getElementById('statusInactiveBtn').classList.toggle('selected', s==='inactive');
}

async function submitStudentForm(){
  const name = document.getElementById('f_name').value.trim();
  const email = document.getElementById('f_email').value.trim();
  const phone = document.getElementById('f_phone').value.trim();
  if(!name || !email){ showToast('Please fill in name and email.', 'error'); return; }
  
  // Phone: must be 10 digits (optional +country code) — show inline error if not
  const phoneOk = isValidPhone(phone);
  document.getElementById('f_phone').classList.toggle('invalid', !phoneOk);
  const phoneErr = document.getElementById('f_phone_error');
  if(phoneErr) phoneErr.style.display = phoneOk ? 'none' : '';
  if(!phoneOk) return;
  
  const payload = {
    name, email,
    phone,
    gender: document.getElementById('f_gender').value,
    department: document.getElementById('f_dept').value,
    semester: document.getElementById('f_sem').value,
    enroll_date: document.getElementById('f_enroll').value || todayISO(),
    status: state.currentStatus,
    avatar: hashPick(AVATAR_GRADIENTS, name) 
  };
  
  toggleLoader(true);
  try {
      if(state.editingId){
          await apiCall(`/students/${state.editingId}`, 'PUT', payload);
          showToast('Student profile updated.', 'success');
      } else {
          await apiCall('/students', 'POST', payload);
          showToast('New student added.', 'success');
      }      closeStudentModal();
      await fetchStudents();
      fetchStudentsPage();
  } catch(err) {
      showToast(err.message, 'error');
  } finally {
      toggleLoader(false);
  }
}

/* Delete */
function openDeleteModal(id){
  state.deletingId = id;
  const s = state.students.find(x=>x.id===id);
  document.getElementById('deleteModalText').textContent = `Remove ${s.name} from the system? This action can't be undone.`;
  document.getElementById('deleteModalBackdrop').classList.add('open');
}
function closeDeleteModal(){ document.getElementById('deleteModalBackdrop').classList.remove('open'); state.deletingId=null; }

async function confirmDelete(){
    toggleLoader(true);
    try {
        await apiCall(`/students/${state.deletingId}`, 'DELETE');
        showToast('Student removed.', 'success');
        closeDeleteModal();
        await fetchStudents();
        fetchStudentsPage();
    } catch(err) {
        showToast(err.message, 'error');
    } finally {
        toggleLoader(false);
    }
}

/* ============================================================
   ATTENDANCE VIEW
============================================================ */
function renderAttendanceView(){
  document.getElementById('attDate').value = state.attendanceDate;
  const dept = document.getElementById('attDeptFilter').value;
  const sem = document.getElementById('attSemFilter').value;
  
  const container = document.getElementById('attendanceList');
  
  if(!dept || !sem) {
    container.innerHTML = `<div class="empty-state"><p>Please select a Department and Semester to load students.</p></div>`;
    document.getElementById('attSummary').innerHTML = '';
    return;
  }
  
  const list = state.students.filter(s=> s.department===dept && s.semester===sem);
  
  container.innerHTML = list.map(s=>{
    const rec = s.attendance && s.attendance[state.attendanceDate];
    return `
    <div class="person-row" data-att-id="${s.id}">
      <div class="avatar" style="background:${esc(s.avatar) || 'var(--grad-primary)'}">${initials(s.name)}</div>
      <div class="person-info">
        <div class="person-name">${esc(s.name)}</div>
        <div class="person-meta">${esc(s.department)} · ${esc(s.semester)}</div>
      </div>
      <div class="att-toggle-group">
        <button class="att-toggle p ${rec==='present'?'selected':''}" onclick="setAttMark('${s.id}','present')">P</button>
        <button class="att-toggle l ${rec==='late'?'selected':''}" onclick="setAttMark('${s.id}','late')">L</button>
        <button class="att-toggle a ${rec==='absent'?'selected':''}" onclick="setAttMark('${s.id}','absent')">A</button>
      </div>
    </div>`;
  }).join('') || emptyRow();
  renderAttSummary(list);
}

async function setAttMark(id, mark){
  const s = state.students.find(x=>x.id===id);
  if(!s) return;
  if(!s.attendance) s.attendance = {};
  const prev = s.attendance[state.attendanceDate];
  s.attendance[state.attendanceDate] = mark;
  renderAttendanceView();
  try {
    await apiCall(`/students/${id}/attendance`, 'PUT', { date: state.attendanceDate, status: mark });
  } catch(err){
    // Roll back the optimistic update so the UI matches what was actually saved
    if(prev === undefined) delete s.attendance[state.attendanceDate];
    else s.attendance[state.attendanceDate] = prev;
    renderAttendanceView();
    showToast(err.message, 'error');
  }
}

function renderAttSummary(list){
  let p=0,a=0,l=0;
  list.forEach(s=>{
    const rec = s.attendance && s.attendance[state.attendanceDate];
    if(rec==='present') p++; else if(rec==='absent') a++; else if(rec==='late') l++;
  });
  document.getElementById('attSummary').innerHTML = `
    <div class="att-chip"><span class="att-dot" style="background:#1fcfa8"></span>Present: ${p}</div>
    <div class="att-chip"><span class="att-dot" style="background:#ffb648"></span>Late: ${l}</div>
    <div class="att-chip"><span class="att-dot" style="background:#ff6b81"></span>Absent: ${a}</div>
    <div class="att-chip"><span class="att-dot" style="background:${accentColors().primary}"></span>Total: ${list.length}</div>
  `;
}
document.getElementById('attDate').addEventListener('change', (e)=>{
  state.attendanceDate = e.target.value || todayISO();
  renderAttendanceView();
});
document.getElementById('attDeptFilter').addEventListener('change', renderAttendanceView);
document.getElementById('attSemFilter').addEventListener('change', renderAttendanceView);
async function saveAttendance(){
  showToast('Attendance saved for ' + state.attendanceDate + '.', 'success');
  await fetchStudents();
}

/* Printable attendance sheet (admin only) */
async function downloadAttendanceSheet(){
  const dept = document.getElementById('attDeptFilter').value;
  const sem = document.getElementById('attSemFilter').value;
  if(!dept || !sem){ showToast('Select a Department and Semester first.', 'error'); return; }
  const date = state.attendanceDate || todayISO();
  const params = new URLSearchParams({ department: dept, semester: sem, date });
  try {
    const res = await fetch(`${API_URL}/reports/attendance-sheet?${params}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if(!res.ok){
      let msg = 'Download failed';
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      showToast(msg, 'error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${dept}-${date}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Attendance sheet downloaded.', 'success');
  } catch(err){ showToast('Download failed: ' + err.message, 'error'); }
}

/* ============================================================
   RESULTS VIEW (Formerly Grades)
============================================================ */
function renderResultsView(){
  const dept = document.getElementById('resDeptFilter').value;
  const sem = document.getElementById('resSemFilter').value;
  const subj = document.getElementById('resSubjectFilter').value || SUBJECTS[0];
  const sort = document.getElementById('resSortFilter').value;
  
  let list = state.students.filter(s=> (!dept || s.department===dept) && (!sem || s.semester===sem));
  
  // Sort Logic
  if (sort === 'rank') {
    list.sort((a,b) => studentAvgGrade(b) - studentAvgGrade(a));
  } else {
    list.sort((a,b) => a.name.localeCompare(b.name));
  }

  document.getElementById('gradeTableBody').innerHTML = list.map(s=>{
    const score = (s.grades && s.grades[subj]) || 0;
    const letter = letterGrade(score);
    const avg = studentAvgGrade(s);
    return `
    <tr>
      <td><div style="display:flex;align-items:center;gap:10px;"><div class="avatar" style="width:32px;height:32px;font-size:11.5px;background:${esc(s.avatar) || 'var(--grad-primary)'}">${initials(s.name)}</div>${esc(s.name)}</div></td>
      <td>${esc(s.department)} · ${esc(s.semester)}</td>
      <td><input type="number" min="0" max="100" class="grade-input" value="${score}" onchange="updateGrade('${s.id}','${subj}',this.value)"></td>
      <td><span class="grade-badge" style="background:${gradeColor(letter)};width:30px;height:30px;font-size:12px;">${letter}</span></td>
      <td class="avg-cell">${avg}%</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5"><div class="empty-state"><p>No students found.</p></div></td></tr>`;
}
async function updateGrade(id, subj, val){
  const s = state.students.find(x=>x.id===id);
  if(!s) return;
  let v = parseInt(val,10); if(isNaN(v)) v=0; v = Math.max(0,Math.min(100,v));
  if(!s.grades) s.grades = {};
  const prev = s.grades[subj];
  s.grades[subj] = v;
  renderResultsView();
  renderStatCards();
  renderDeptChart();
  try {
    await apiCall(`/students/${id}/grades`, 'PUT', { subject: subj, score: v });
    showToast(`Updated ${subj} score for ${esc(s.name)}.`, 'success');
  } catch(err){
    // Roll back the optimistic update so the UI matches what was actually saved
    if(prev === undefined) delete s.grades[subj];
    else s.grades[subj] = prev;
    renderResultsView();
    renderStatCards();
    renderDeptChart();
    showToast(err.message, 'error');
  }
}
['resDeptFilter', 'resSemFilter', 'resSubjectFilter', 'resSortFilter'].forEach(id => {
  document.getElementById(id).addEventListener('change', renderResultsView);
});

/* ============================================================
   REPORTS VIEW
============================================================ */
function renderReports(){
  const generateReportHTML = (dept) => {
    return SEMESTERS.map(sem=>{
      const list = state.students.filter(s=>s.department===dept && s.semester===sem);
      if(!list.length) return `<div class="person-row"><div class="person-info"><div class="person-name">${sem}</div><div class="person-meta">0 students enrolled</div></div></div>`;
      
      const avg = Math.round(list.reduce((a,s)=>a+studentAvgGrade(s),0)/list.length);
      const att = Math.round(list.reduce((a,s)=>a+studentAttendanceRate(s),0)/list.length);
      
      return `
        <div class="person-row">
          <div class="avatar" style="background:var(--grad-primary)">${sem.split(' ')[1]}</div>
          <div class="person-info">
            <div class="person-name">${sem}</div>
            <div class="person-meta">${list.length} students enrolled</div>
          </div>
          <span class="pill pill-class">Avg grade ${avg}%</span>
          <span class="pill ${att>=75?'pill-active':'pill-inactive'}">Attendance ${att}%</span>
        </div>
      `;
    }).join('');
  };

  document.getElementById('mcaReportsList').innerHTML = generateReportHTML('MCA');
  document.getElementById('mbaReportsList').innerHTML = generateReportHTML('MBA');
}

/* ============================================================
   STUDENT DETAIL DRAWER
============================================================ */
function openDrawer(id){
  state.currentDrawerId = id;
  const s = state.students.find(x=>x.id===id);
  document.getElementById('drawerHeadContent').innerHTML = `
    <div class="drawer-head">
      <div>
        <div class="avatar" style="background:rgba(255,255,255,0.28)">${initials(s.name)}</div>
        <div class="drawer-name">${esc(s.name)}</div>
        <div class="drawer-meta">${esc(s.department)} · ${esc(s.semester)}</div>
      </div>
      <button class="modal-close" style="background:rgba(255,255,255,0.2);" onclick="closeDrawer()"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>`;
  document.getElementById('tab-profile').innerHTML = `
    <div class="info-line">${ICO.mail}<span class="lbl">Email</span>${esc(s.email)}</div>
    <div class="info-line">${ICO.phone}<span class="lbl">Phone</span>${esc(s.phone)||'—'}</div>
    <div class="info-line">${ICO.cal}<span class="lbl">Enrolled</span>${esc(s.enroll_date)||'—'}</div>
    <div class="info-line">${ICO.users}<span class="lbl">Gender</span>${esc(s.gender)}</div>
    <div class="info-line" style="border-bottom:none;"><span class="lbl">Status</span><span class="pill ${s.status==='active'?'pill-active':'pill-inactive'}">${esc(s.status)}</span></div>
    <div class="modal-actions" style="margin-top:18px;">
      <button class="btn btn-ghost btn-sm" onclick="closeDrawer(); openStudentModal('${s.id}')">${ICO.edit} Edit</button>
      <button class="btn btn-primary btn-sm" onclick="downloadReportCard('${s.id}')">${ICO.download} Report Card</button>
      <button class="btn btn-danger btn-sm" onclick="closeDrawer(); openDeleteModal('${s.id}')">${ICO.trash} Remove</button>
    </div>
  `;
  document.getElementById('tab-grades').innerHTML = SUBJECTS.map(su=>{
    const score = (s.grades && s.grades[su]) || 0; const letter = letterGrade(score);
    return `<div class="info-line"><span class="lbl">${su}</span><span style="flex:1">${score}%</span><span class="grade-badge" style="width:28px;height:28px;font-size:11px;background:${gradeColor(letter)}">${letter}</span></div>`;
  }).join('') + `<div class="info-line" style="border-bottom:none;font-weight:800;"><span class="lbl">Average</span>${studentAvgGrade(s)}%</div>`;
  const days = [];
  for(let i=13;i>=0;i--){ days.push(dateMinus(i)); }
  document.getElementById('tab-attendance').innerHTML = `
    <p class="card-sub" style="margin-bottom:10px;">Last 14 days · Attendance rate ${studentAttendanceRate(s)}%</p>
    <div class="mini-att-grid">${days.map(d=>{
      const r = (s.attendance && s.attendance[d]);
      const bg = r==='present'?'#1fcfa8':(r==='late'?'#ffb648':(r==='absent'?'#ff6b81':'#e4e6f2'));
      const lbl = r? r[0].toUpperCase() : '·';
      return `<div class="mini-att-cell" style="background:${bg}" title="${d}: ${r||'no record'}">${lbl}</div>`;
    }).join('')}</div>
  `;
  document.getElementById('studentDrawer').classList.add('open');
  document.getElementById('drawerBackdrop').classList.add('open');
}
function closeDrawer(){
  document.getElementById('studentDrawer').classList.remove('open');
  document.getElementById('drawerBackdrop').classList.remove('open');
}
function switchTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active', p.id==='tab-'+tab));
}

/* ============================================================
   USERS MANAGEMENT (ADMIN)
============================================================ */
async function fetchUsers(){
  try {
    state.users = await apiCall('/users');
    renderUsers();
  } catch(err){ showToast(err.message, 'error'); }
}

function renderUsers(){
  document.getElementById('usersListBody').innerHTML = state.users.map(u=>`
    <tr>
      <td>
        ${u.name ? `<div class="person-name" style="font-size:13.5px;">${esc(u.name)}</div>` : ''}
        <div class="person-meta">${esc(u.email)}</div>
      </td>
      <td><span class="pill ${u.role==='admin'?'pill-active':'pill-class'}">${esc(u.role)}</span></td>
      <td>${esc(u.created_at||'—')}</td>
      <td style="text-align:right;">${u.id===state.currentUserId
        ? '<span class="pill pill-class">You</span>'
        : `<div style="display:flex; gap:8px; justify-content:flex-end;">
             <button class="icon-btn-sm" title="Reset password" onclick="openResetPasswordModal('${u.id}')">${ICO.key}</button>
             <button class="icon-btn-sm danger" title="Delete user" onclick="deleteUser('${u.id}')">${ICO.trash}</button>
           </div>`}</td>
    </tr>`).join('') || '<tr><td colspan="4"><div class="empty-state"><p>No users yet.</p></div></td></tr>';
}

/* Password reset (admin) */
function openResetPasswordModal(id){
  const u = state.users.find(x=>x.id===id);
  if(!u) return;
  state.resetUserId = id;
  document.getElementById('resetUserEmail').textContent = u.email;
  document.getElementById('rp_password').value = '';
  document.getElementById('resetPasswordBackdrop').classList.add('open');
  setTimeout(()=>document.getElementById('rp_password').focus(), 50);
}
function closeResetPasswordModal(){ document.getElementById('resetPasswordBackdrop').classList.remove('open'); state.resetUserId = null; }
async function submitResetPassword(){
  const password = document.getElementById('rp_password').value;
  if(!password || password.length < 6){ showToast('Password must be at least 6 characters.', 'error'); return; }
  toggleLoader(true);
  try {
    await apiCall(`/users/${state.resetUserId}/password`, 'PUT', { password });
    showToast('Password reset.', 'success');
    closeResetPasswordModal();
  } catch(err){ showToast(err.message, 'error'); }
  finally { toggleLoader(false); }
}

function openUserModal(){
  document.getElementById('userModalBackdrop').classList.add('open');
  setTimeout(()=>document.getElementById('u_email').focus(), 50);
}
function closeUserModal(){ document.getElementById('userModalBackdrop').classList.remove('open'); }

async function submitUserForm(){
  const email = document.getElementById('u_email').value.trim();
  const password = document.getElementById('u_password').value;
  const role = document.getElementById('u_role').value;
  if(!email || !password){ showToast('Email and password are required.', 'error'); return; }
  toggleLoader(true);
  try {
    await apiCall('/users', 'POST', { email, password, role });
    showToast('User created.', 'success');
    closeUserModal();
    document.getElementById('u_password').value = '';
    await fetchUsers();
  } catch(err){ showToast(err.message, 'error'); }
  finally { toggleLoader(false); }
}

/* Change own password (any logged-in role) */
async function changePassword(){
  const currentPassword = document.getElementById('cp_current').value;
  const newPassword = document.getElementById('cp_new').value;
  const confirm = document.getElementById('cp_confirm').value;
  if(!currentPassword || !newPassword){ showToast('Fill in both current and new password.', 'error'); return; }
  if(newPassword.length < 6){ showToast('New password must be at least 6 characters.', 'error'); return; }
  if(newPassword !== confirm){ showToast('Passwords do not match.', 'error'); return; }
  toggleLoader(true);
  try {
    await apiCall('/auth/password', 'PUT', { currentPassword, newPassword });
    showToast('Password updated.', 'success');
    document.getElementById('cp_current').value = '';
    document.getElementById('cp_new').value = '';
    document.getElementById('cp_confirm').value = '';
  } catch(err){ showToast(err.message, 'error'); }
  finally { toggleLoader(false); }
}

/* Email verification — fired when the app opens with ?verify=TOKEN */
async function handleVerifyToken(token){
  if(!token) return;
  toggleLoader(true);
  try {
    const res = await fetch(`${API_URL}/auth/verify-email?token=${encodeURIComponent(token)}`);
    const data = await res.json().catch(()=>({}));
    if(res.ok){
      document.getElementById('verifyEmailText').textContent = data.message || 'Your account is now active. Sign in to continue.';
      document.getElementById('verifySuccessModalBackdrop').classList.add('open');
    } else {
      showToast(data.error || 'Verification failed. The link may be expired.', 'error');
    }
  } catch(err){ showToast('Verification failed: ' + err.message, 'error'); }
  finally { toggleLoader(false); }
}
function closeVerifyModalAndSignIn(){
  document.getElementById('verifySuccessModalBackdrop').classList.remove('open');
  switchAuthTab('signin');
}

/* Edit own profile (any logged-in role) */
function loadProfileIntoForm(){
  const nameEl = document.getElementById('profile_name');
  if(nameEl) nameEl.value = state.userName || '';
  const emailEl = document.getElementById('profile_email');
  if(emailEl) emailEl.value = state.userEmail || '';
}
async function updateProfileName(){
  const name = document.getElementById('profile_name').value.trim();
  if(!name){ showToast('Name is required.', 'error'); return; }
  toggleLoader(true);
  try {
    const data = await apiCall('/auth/profile', 'PUT', { name });
    state.userName = data.name || name;
    localStorage.setItem('userName', state.userName);
    updateUserDisplay();
    showToast('Profile updated.', 'success');
  } catch(err){ showToast(err.message, 'error'); }
  finally { toggleLoader(false); }
}

/* Email-based password reset (request link) */
function openForgotModal(){
  document.getElementById('forgotModalBackdrop').classList.add('open');
  setTimeout(()=>document.getElementById('fg_email').focus(), 50);
}
function closeForgotModal(){ document.getElementById('forgotModalBackdrop').classList.remove('open'); }
async function submitForgot(){
  const email = document.getElementById('fg_email').value.trim();
  if(!email){ showToast('Enter your email address.', 'error'); return; }
  toggleLoader(true);
  try {
    await apiCall('/auth/forgot-password', 'POST', { email });
    showToast('If an account exists for that email, a reset link has been sent.', 'info');
    closeForgotModal();
  } catch(err){ showToast(err.message, 'error'); }
  finally { toggleLoader(false); }
}

/* Set a new password from the emailed reset token */
function openPasswordResetModal(token){
  document.getElementById('pr_token').value = token || '';
  document.getElementById('pr_password').value = '';
  document.getElementById('pr_confirm').value = '';
  document.getElementById('passwordResetModalBackdrop').classList.add('open');
  setTimeout(()=>document.getElementById('pr_password').focus(), 50);
}
function closePasswordResetModal(){ document.getElementById('passwordResetModalBackdrop').classList.remove('open'); }
async function submitPasswordReset(){
  const token = document.getElementById('pr_token').value;
  const pw = document.getElementById('pr_password').value;
  const cf = document.getElementById('pr_confirm').value;
  if(!token){ showToast('Missing reset token.', 'error'); return; }
  if(pw.length < 6){ showToast('Password must be at least 6 characters.', 'error'); return; }
  if(pw !== cf){ showToast('Passwords do not match.', 'error'); return; }
  toggleLoader(true);
  try {
    await apiCall('/auth/reset-password', 'POST', { token, newPassword: pw });
    showToast('Password reset successful — log in with your new password.', 'success');
    closePasswordResetModal();
  } catch(err){ showToast(err.message, 'error'); }
  finally { toggleLoader(false); }
}

/* ============================================================
   REPORTS EXPORT (CSV / PDF)
============================================================ */
/* Per-student report card (PDF) */
async function downloadReportCard(id){
  try {
    const res = await fetch(`${API_URL}/students/${id}/report-card`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if(!res.ok){
      let msg = 'Download failed';
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      showToast(msg, 'error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'report-card.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Report card downloaded.', 'success');
  } catch(err){ showToast('Download failed: ' + err.message, 'error'); }
}

async function exportReport(format){
  try {
    const res = await fetch(`${API_URL}/reports/export?format=${format}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if(!res.ok){
      let msg = 'Export failed';
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      showToast(msg, 'error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cohort-report.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Report exported as ${format.toUpperCase()}.`, 'success');
  } catch(err){ showToast('Export failed: ' + err.message, 'error'); }
}

async function deleteUser(id){
  const u = state.users.find(x=>x.id===id);
  if(!u || u.id===state.currentUserId) return;
  if(!confirm(`Remove ${u.email}? This cannot be undone.`)) return;
  toggleLoader(true);
  try {
    await apiCall(`/users/${id}`, 'DELETE');
    showToast('User removed.', 'success');
    await fetchUsers();
  } catch(err){ showToast(err.message, 'error'); }
  finally { toggleLoader(false); }
}

/* ============================================================
   AUDIT LOG (ADMIN)
============================================================ */
async function fetchAudit(){
  try {
    const logs = await apiCall('/audit?limit=15');
    renderAudit(logs);
  } catch(err){ /* silently ignore — non-fatal */ }
}

function renderAudit(logs){
  document.getElementById('auditList').innerHTML = logs.map(l=>`
    <div class="person-row">
      <div class="person-info" style="flex:1;">
        <div class="person-name" style="font-size:13px;">
          <span class="pill ${l.action.startsWith('user')||l.action.startsWith('auth')?'pill-active':'pill-class'}" style="font-size:10.5px;text-transform:uppercase;">${esc(l.action)}</span>
          <span style="margin-left:8px;">${esc(l.details||'')}</span>
        </div>
        <div class="person-meta">${esc(l.email||'system')} · ${esc(l.created_at||'')}</div>
      </div>
    </div>`).join('') || '<div class="empty-state"><p>No activity recorded yet.</p></div>';
}
function showToast(msg, type){
  const wrap = document.getElementById('toastWrap');
  if(!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (type||'success');
  el.innerHTML = (type==='error' ? ICO.alert : (type==='info' ? ICO.key : ICO.check)) + `<span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateY(8px)'; el.style.transition='all 0.3s ease'; setTimeout(()=>el.remove(),300); }, 2600);
}

/* ============================================================
   KEYBOARD SHORTCUTS
============================================================ */
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){
    closeThemeMenu();
    closeStudentModal();
    closeUserModal();
    closeForgotModal();
    closePasswordResetModal();
    closeResetPasswordModal();
    closeDeleteModal();
    closeDrawer();
    closeSidebarMobile();
  }
});

/* ============================================================
   INIT / REFRESH
============================================================ */
async function initApp() {
    console.log("1");
    const isAdmin = state.role === 'admin';

    console.log("2");
    document.body.classList.toggle('role-user', !isAdmin);

    console.log("3");
    document.getElementById('displayRole').textContent =
        isAdmin ? 'Administrator' : 'User';

    console.log("4");
    updateUserDisplay();

    console.log("5");
    loadProfileIntoForm();

    console.log("6");
    loadInstitutionSettings();

    console.log("7");
    await fetchStudents();

    console.log("8");
    fetchStudentsPage();

    console.log("9");
    if (isAdmin) {
        fetchUsers();
        fetchAudit();
    }

    console.log("10");
    if (!isAdmin) switchView('attendance');

    console.log("DONE");
}

function init(){
  populateFilters();

  // Emailed reset link arrives as http://.../?reset=TOKEN — open the set-new-password modal
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get('reset');
  if(resetToken){
    openPasswordResetModal(resetToken);
    history.replaceState(null, '', window.location.pathname);
  }
  const verifyToken = params.get('verify');
  if(verifyToken){
    handleVerifyToken(verifyToken);
    history.replaceState(null, '', window.location.pathname);
  }

  if(state.token) {
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('mainApp').style.display = 'flex';
      initApp();
  }
}

init();