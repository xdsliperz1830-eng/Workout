'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let currentLang    = localStorage.getItem('mtracker_lang') || 'en';
let activeWorkout  = null;   // { type, exercises }
let currentView    = 'home';

// ─── i18n helpers ─────────────────────────────────────────────────────────────

function t(key) {
  return (UI[currentLang] || UI.en)[key] || UI.en[key] || key;
}

function wtName(wt)    { return wt.names[currentLang]   || wt.names.en; }
function wtDesc(wt)    { return wt.descs[currentLang]   || wt.descs.en; }
function wtMuscles(wt) { return wt.muscles[currentLang] || wt.muscles.en; }

function exName(ex) {
  if (ex.names) return ex.names[currentLang] || ex.names.en || Object.values(ex.names)[0] || 'Exercise';
  return 'Exercise';
}
function exDesc(ex) {
  if (ex.descriptions) return ex.descriptions[currentLang] || ex.descriptions.en || '';
  return '';
}

function setLang(code) {
  if (!LANGUAGES[code]) return;
  currentLang = code;
  localStorage.setItem('mtracker_lang', code);

  // Update flag button active state
  document.querySelectorAll('.lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === code)
  );

  // Re-render current view
  if (currentView === 'home')    renderHome();
  if (currentView === 'history') renderHistory();
  if (currentView === 'workout' && activeWorkout) {
    renderWorkoutHeader(activeWorkout.type);
    const done = todayEntry()?.workoutId === activeWorkout.type.id;
    renderExercises(activeWorkout.exercises, activeWorkout.type, done);
  }

  // Update static nav labels
  updateNavLabels();
}

function updateNavLabels() {
  const labels = document.querySelectorAll('.nav-btn span');
  const keys   = ['home', 'workout', 'history'];
  labels.forEach((el, i) => { el.textContent = t(keys[i]); });
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'mtracker_history_v1';
const CACHE_PFX   = 'mtracker_cache_v2_';   // v2 stores all translations

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function addToHistory(workoutId, workoutName) {
  const history = getHistory().filter(h => h.date !== todayStr());
  history.unshift({ date: todayStr(), workoutId, workoutName });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 90)));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayStr() { return new Date().toISOString().slice(0, 10); }

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr + 'T12:00:00').getTime()) / 86400000);
}

function formatDate(dateStr) {
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === todayStr()) return t('today');
  if (dateStr === yest)       return t('yesterday');
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── Suggestion algorithm ─────────────────────────────────────────────────────

function todayEntry() {
  return getHistory().find(h => h.date === todayStr()) || null;
}

function getSuggestion() {
  const history = getHistory();
  const done    = todayEntry();
  if (done) return WORKOUT_TYPES.find(w => w.id === done.workoutId) || WORKOUT_TYPES[0];

  const scored = WORKOUT_TYPES.map(wt => {
    const last = history.filter(h => h.workoutId === wt.id)
                        .sort((a, b) => b.date.localeCompare(a.date))[0];
    return { wt, score: last ? daysSince(last.date) : 999 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].wt;
}

// ─── API / caching ────────────────────────────────────────────────────────────

async function getCached(catId) {
  try {
    const raw = localStorage.getItem(CACHE_PFX + catId);
    if (raw) {
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts < 48 * 3600 * 1000) return data;
    }
  } catch { /* ignore */ }
  return null;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchCategory(catId) {
  const cached = await getCached(catId);
  if (cached) return cached;

  try {
    // Fetch with high limit; language=2 ensures English translation exists
    const res = await fetch(
      `https://wger.de/api/v2/exerciseinfo/?format=json&language=2&category=${catId}&limit=80&offset=0`
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();

    const exercises = json.results.map(ex => {
      // Build names + descriptions map from all available translations
      const names        = {};
      const descriptions = {};
      for (const tr of (ex.translations || [])) {
        const short = tr.language?.short_name;
        if (short && tr.name?.trim()) {
          names[short] = tr.name.trim();
          const d = stripHtml(tr.description || '');
          if (d) descriptions[short] = d.slice(0, 300);
        }
      }
      if (!names.en) return null; // skip if no English name

      return {
        id:           ex.id,
        names,
        descriptions,
        image:        ex.images?.find(i => i.is_main)?.image || ex.images?.[0]?.image || null,
        allImages:    ex.images?.map(i => i.image).filter(Boolean) || [],
        muscles:      ex.muscles?.map(m => m.name_en).filter(Boolean).join(', ') || ex.category?.name || '',
      };
    }).filter(Boolean);

    // Sort: exercises with images first (maximises photos shown)
    exercises.sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));

    localStorage.setItem(CACHE_PFX + catId, JSON.stringify({ data: exercises, ts: Date.now() }));
    return exercises;
  } catch (err) {
    console.warn('API unavailable for category', catId, err);
    return null;
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadExercisesForWorkout(wt) {
  const result = [];

  for (const cat of wt.categories) {
    const live = await fetchCategory(cat.id);
    const pool = live ?? FALLBACK[cat.id] ?? [];

    // Separate exercises with/without images, shuffle each group, prefer images
    const withImg    = pool.filter(e => e.image);
    const withoutImg = pool.filter(e => !e.image);
    const ordered    = [...shuffle(withImg), ...shuffle(withoutImg)];
    const picked     = ordered.slice(0, cat.count);
    result.push(...picked);
  }

  // Top up to 8 if still short
  if (result.length < 8) {
    const live = await getCached(wt.categories[0].id);
    const pool = live ?? FALLBACK[wt.categories[0].id] ?? [];
    for (const ex of pool) {
      if (result.length >= 8) break;
      if (!result.find(e => e.id === ex.id)) result.push(ex);
    }
  }

  return result.slice(0, 8);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderHome() {
  document.getElementById('header-date').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const wt      = getSuggestion();
  const done    = !!todayEntry();
  const history = getHistory();

  // Section labels
  document.querySelector('#view-home .section-label:first-child').textContent = t('todaySuggestion');
  document.querySelector('#view-home .section-label:last-of-type').textContent = t('muscleStatus');

  // Suggestion card
  document.getElementById('suggestion-card').innerHTML = `
    <div class="s-card" style="background:${wt.gradient}">
      <span class="s-emoji">${wt.emoji}</span>
      <div class="s-name">
        ${wtName(wt)}
        ${done ? `<span class="done-badge">${t('doneBadge')}</span>` : ''}
      </div>
      <div class="s-desc">${wtDesc(wt)}</div>
      <div class="s-tags">
        ${wtMuscles(wt).map(m => `<span class="s-tag">${m}</span>`).join('')}
        <span class="s-tag">8 ${t('exercises')}</span>
      </div>
      <button class="btn-start" onclick="startWorkout('${wt.id}')">
        ${done ? t('viewAgain') : t('startWorkout')}
      </button>
    </div>
  `;

  // Muscle status rows
  document.getElementById('muscle-status').innerHTML = WORKOUT_TYPES.map(w => {
    const last = history.filter(h => h.workoutId === w.id)
                        .sort((a, b) => b.date.localeCompare(a.date))[0];
    let label = t('neverDone'), cls = '';
    if (last) {
      const d = daysSince(last.date);
      if (d === 0)      { label = t('today');     cls = 'fresh';  }
      else if (d === 1) { label = t('yesterday'); cls = 'medium'; }
      else              { label = `${d} ${t('dAgo')}`; cls = d <= 2 ? 'medium' : 'ripe'; }
    }
    return `
      <div class="status-row">
        <div class="status-left">
          <div class="status-dot" style="background:${w.color}"></div>
          <div>
            <div class="status-name">${wtName(w)}</div>
            <div class="status-subs">${wtMuscles(w).join(' · ')}</div>
          </div>
        </div>
        <div class="status-days ${cls}">${label}</div>
      </div>
    `;
  }).join('');
}

function renderWorkoutHeader(wt) {
  document.getElementById('workout-header').innerHTML = `
    <div class="wkt-header">
      <h2>${wt.emoji} ${wtName(wt)}</h2>
      <p>${wtDesc(wt)} · 8 ${t('exercises')}</p>
    </div>
  `;
}

function renderExercises(exercises, wt, alreadyDone) {
  const grid = document.getElementById('exercise-grid');

  if (!exercises.length) {
    grid.innerHTML = `
      <div class="loading-wrap">
        <div>⚠️ ${t('noConnection')}</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = exercises.map((ex, i) => {
    const icon  = wt.icons[i % 4];
    const name  = exName(ex);
    return `
      <div class="ex-card" onclick="openDetail(${i})">
        <div class="ex-img-wrap">
          ${ex.image
            ? `<img class="ex-img" src="${ex.image}" alt="${name}" loading="lazy"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ''}
          <div class="ex-placeholder" style="${ex.image ? 'display:none' : ''};background:${wt.gradient}">
            <span style="font-size:36px">${icon}</span>
            <span class="ex-placeholder-name">${name}</span>
          </div>
          <div class="ex-num">${i + 1}</div>
        </div>
        <div class="ex-info">
          <div class="ex-name">${name}</div>
          <div class="ex-mus">${ex.muscles || ''}</div>
        </div>
      </div>
    `;
  }).join('');

  const btn = document.getElementById('btn-complete');
  btn.textContent = alreadyDone ? t('completedToday') : t('markComplete');
  btn.classList.toggle('done', alreadyDone);
}

function renderHistory() {
  document.querySelector('#view-history .section-label').textContent = t('workoutHistory');
  const history   = getHistory();
  const container = document.getElementById('history-list');

  if (!history.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="big">📝</div>
        <strong>${t('noHistory')}</strong>
        <div>${t('noHistoryHint')}</div>
      </div>
    `;
    return;
  }

  const rows = [];
  for (let i = 0; i < 21; i++) {
    const ds    = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const entry = history.find(h => h.date === ds);
    const wt    = entry ? WORKOUT_TYPES.find(w => w.id === entry.workoutId) : null;

    if (entry && wt) {
      rows.push(`
        <div class="hist-item">
          <div class="hist-bar" style="background:${wt.color}"></div>
          <div class="hist-info">
            <div class="hist-name">${wtName(wt)}</div>
            <div class="hist-date">${formatDate(ds)}</div>
          </div>
          <div class="hist-icon">${wt.emoji}</div>
        </div>
      `);
    } else {
      rows.push(`
        <div class="hist-item">
          <div class="hist-bar" style="background:var(--border)"></div>
          <div class="hist-info">
            <div class="hist-name rest-day">${t('restDay')}</div>
            <div class="hist-date">${formatDate(ds)}</div>
          </div>
          <div class="hist-icon">😴</div>
        </div>
      `);
    }
  }
  container.innerHTML = rows.join('');
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function showView(name) {
  currentView = name;
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name)
  );
  document.getElementById('view-home').classList.toggle('hidden',    name !== 'home');
  document.getElementById('view-workout').classList.toggle('hidden', name !== 'workout');
  document.getElementById('view-history').classList.toggle('hidden', name !== 'history');
  document.getElementById('main').scrollTop = 0;

  if (name === 'home')    renderHome();
  if (name === 'history') renderHistory();
  if (name === 'workout' && !activeWorkout) startWorkout(getSuggestion().id);
}

// ─── Workout flow ──────────────────────────────────────────────────────────────

async function startWorkout(workoutId) {
  const wt = WORKOUT_TYPES.find(w => w.id === workoutId);
  if (!wt) return;

  activeWorkout = { type: wt, exercises: [] };
  showView('workout');
  renderWorkoutHeader(wt);

  // Show loading skeleton
  document.getElementById('exercise-grid').innerHTML = `
    <div class="loading-wrap">
      <div class="spinner"></div>
      <div>${t('loading')}</div>
    </div>
  `;
  document.getElementById('btn-complete').textContent = t('markComplete');
  document.getElementById('btn-complete').classList.remove('done');

  const exercises     = await loadExercisesForWorkout(wt);
  activeWorkout.exercises = exercises;

  const done = todayEntry()?.workoutId === workoutId;
  renderExercises(exercises, wt, done);
}

function completeWorkout() {
  if (!activeWorkout) return;
  const btn = document.getElementById('btn-complete');
  if (btn.classList.contains('done')) return;

  const { type } = activeWorkout;
  addToHistory(type.id, wtName(type));
  btn.textContent = t('completedToday');
  btn.classList.add('done');
  toast(`${type.emoji} ${wtName(type)}`);
}

// ─── Exercise detail modal ────────────────────────────────────────────────────

function openDetail(index) {
  if (!activeWorkout) return;
  const ex = activeWorkout.exercises[index];
  if (!ex) return;

  const name = exName(ex);
  const desc = exDesc(ex);
  // Show first available image; if main fails show second image
  const imgs = ex.allImages || (ex.image ? [ex.image] : []);

  const el = document.createElement('div');
  el.className = 'modal-bg';
  el.innerHTML = `
    <div class="modal-box">
      <button class="modal-close" onclick="this.closest('.modal-bg').remove()">✕</button>
      ${imgs.length
        ? `<img class="modal-img" src="${imgs[0]}" alt="${name}"
             onerror="this.src='${imgs[1] || ''}'; this.onerror=null">`
        : `<div class="modal-img-placeholder" style="background:${activeWorkout.type.gradient}">
             ${activeWorkout.type.emoji}
           </div>`
      }
      <div class="modal-title">${name}</div>
      <div class="modal-mus">${ex.muscles || ''}</div>
      ${desc ? `<div class="modal-desc">${desc}</div>` : ''}
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 2800);
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Restore saved language
  document.querySelectorAll('.lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === currentLang)
  );
  updateNavLabels();
  renderHome();
});
