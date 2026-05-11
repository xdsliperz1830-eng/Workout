'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let activeWorkout = null;   // { type: WorkoutType, exercises: Exercise[] }
let currentView   = 'home';

// ─── Storage ──────────────────────────────────────────────────────────────────

const HISTORY_KEY  = 'mtracker_history_v1';
const CACHE_PFX    = 'mtracker_cache_v1_';

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function addToHistory(workoutId, workoutName) {
  const history = getHistory().filter(h => h.date !== todayStr());
  history.unshift({ date: todayStr(), workoutId, workoutName });
  saveHistory(history.slice(0, 90)); // keep 3 months
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr + 'T12:00:00').getTime()) / 86400000);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const today = todayStr();
  const yest  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === today) return 'Today';
  if (dateStr === yest)  return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── Suggestion algorithm ─────────────────────────────────────────────────────

function todayEntry() {
  return getHistory().find(h => h.date === todayStr()) || null;
}

function getSuggestion() {
  const history = getHistory();
  const done = todayEntry();
  if (done) return WORKOUT_TYPES.find(w => w.id === done.workoutId) || WORKOUT_TYPES[0];

  // Score each type: higher days-since = higher priority; never done = 999
  const scored = WORKOUT_TYPES.map(wt => {
    const last = history.filter(h => h.workoutId === wt.id).sort((a, b) => b.date.localeCompare(a.date))[0];
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

function extractName(ex) {
  if (ex.translations && ex.translations.length) {
    const en = ex.translations.find(t => t.language?.id === 2 || t.language?.short_name === 'en')
            || ex.translations[0];
    if (en?.name?.trim()) return en.name.trim();
  }
  return (ex.name || '').trim() || 'Exercise';
}

function extractDesc(ex) {
  if (ex.translations && ex.translations.length) {
    const en = ex.translations.find(t => t.language?.id === 2 || t.language?.short_name === 'en')
            || ex.translations[0];
    return stripHtml(en?.description || '').slice(0, 250);
  }
  return stripHtml(ex.description || '').slice(0, 250);
}

async function fetchCategory(catId) {
  const cached = await getCached(catId);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://wger.de/api/v2/exerciseinfo/?format=json&language=2&category=${catId}&limit=30&offset=0`
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();

    const exercises = json.results.map(ex => ({
      id: ex.id,
      name: extractName(ex),
      description: extractDesc(ex),
      image: ex.images?.find(i => i.is_main)?.image || ex.images?.[0]?.image || null,
      muscles: ex.muscles?.map(m => m.name_en).filter(Boolean).join(', ') || ex.category?.name || '',
      category: ex.category?.name || '',
    })).filter(ex => ex.name && ex.name !== 'Exercise');

    localStorage.setItem(CACHE_PFX + catId, JSON.stringify({ data: exercises, ts: Date.now() }));
    return exercises;
  } catch (err) {
    console.warn('API unavailable for category', catId, err);
    return null; // signals fallback needed
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
    const picked = shuffle(pool).slice(0, cat.count);
    result.push(...picked);
  }

  // Top up to 8 if short
  if (result.length < 8) {
    const firstCat = wt.categories[0];
    const live = await getCached(firstCat.id);
    const pool = live ?? FALLBACK[firstCat.id] ?? [];
    for (const ex of shuffle(pool)) {
      if (result.length >= 8) break;
      if (!result.find(e => e.id === ex.id)) result.push(ex);
    }
  }

  return result.slice(0, 8);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderHome() {
  // Date in header
  document.getElementById('header-date').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const wt      = getSuggestion();
  const done    = !!todayEntry();
  const history = getHistory();

  // Suggestion card
  document.getElementById('suggestion-card').innerHTML = `
    <div class="s-card" style="background:${wt.gradient}">
      <span class="s-emoji">${wt.emoji}</span>
      <div class="s-name">
        ${wt.name}
        ${done ? '<span class="done-badge">✓ Done</span>' : ''}
      </div>
      <div class="s-desc">${wt.description}</div>
      <div class="s-tags">
        ${wt.muscles.map(m => `<span class="s-tag">${m}</span>`).join('')}
        <span class="s-tag">8 exercises</span>
      </div>
      <button class="btn-start" onclick="startWorkout('${wt.id}')">
        ${done ? '▶ View Again' : '▶ Start Workout'}
      </button>
    </div>
  `;

  // Muscle status rows
  document.getElementById('muscle-status').innerHTML = WORKOUT_TYPES.map(w => {
    const last = history.filter(h => h.workoutId === w.id).sort((a, b) => b.date.localeCompare(a.date))[0];
    let label = 'Never done', cls = '';
    if (last) {
      const d = daysSince(last.date);
      if (d === 0) { label = 'Today';     cls = 'fresh'; }
      else if (d === 1) { label = 'Yesterday'; cls = 'medium'; }
      else { label = `${d}d ago`;  cls = d <= 2 ? 'medium' : 'ripe'; }
    }
    return `
      <div class="status-row">
        <div class="status-left">
          <div class="status-dot" style="background:${w.color}"></div>
          <div>
            <div class="status-name">${w.name}</div>
            <div class="status-subs">${w.muscles.join(' · ')}</div>
          </div>
        </div>
        <div class="status-days ${cls}">${label}</div>
      </div>
    `;
  }).join('');
}

function renderWorkoutShell(wt) {
  document.getElementById('workout-header').innerHTML = `
    <div class="wkt-header">
      <h2>${wt.emoji} ${wt.name}</h2>
      <p>${wt.description} · 8 exercises</p>
    </div>
  `;
  document.getElementById('exercise-grid').innerHTML = `
    <div class="loading-wrap">
      <div class="spinner"></div>
      <div>Loading exercises…</div>
    </div>
  `;
  const btn = document.getElementById('btn-complete');
  btn.textContent = '✓ Mark Workout Complete';
  btn.classList.remove('done');
}

function renderExercises(exercises, wt, alreadyDone) {
  const grid = document.getElementById('exercise-grid');

  if (!exercises.length) {
    grid.innerHTML = `
      <div class="loading-wrap">
        <div>⚠️ No exercises loaded</div>
        <div style="font-size:12px;margin-top:6px;color:var(--text2)">Check your internet connection and try again</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = exercises.map((ex, i) => {
    const icon = wt.icons[i % 4];
    return `
      <div class="ex-card" onclick="openDetail(${i})">
        <div class="ex-img-wrap">
          ${ex.image
            ? `<img class="ex-img" src="${ex.image}" alt="${ex.name}" loading="lazy"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ''}
          <div class="ex-placeholder" style="${ex.image ? 'display:none' : ''}">${icon}</div>
          <div class="ex-num">${i + 1}</div>
        </div>
        <div class="ex-info">
          <div class="ex-name">${ex.name}</div>
          <div class="ex-mus">${ex.muscles || ex.category}</div>
        </div>
      </div>
    `;
  }).join('');

  const btn = document.getElementById('btn-complete');
  if (alreadyDone) {
    btn.textContent = '✓ Completed Today';
    btn.classList.add('done');
  }
}

function renderHistory() {
  const history = getHistory();
  const container = document.getElementById('history-list');

  if (!history.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="big">📝</div>
        <strong>No workouts yet</strong>
        <div>Complete your first workout to see it here</div>
      </div>
    `;
    return;
  }

  // Show last 21 days
  const rows = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const ds = d.toISOString().slice(0, 10);
    const entry = history.find(h => h.date === ds);
    const wt = entry ? WORKOUT_TYPES.find(w => w.id === entry.workoutId) : null;

    if (entry && wt) {
      rows.push(`
        <div class="hist-item">
          <div class="hist-bar" style="background:${wt.color}"></div>
          <div class="hist-info">
            <div class="hist-name">${wt.name}</div>
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
            <div class="hist-name rest-day">Rest day</div>
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

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.getElementById('view-home').classList.toggle('hidden',    name !== 'home');
  document.getElementById('view-workout').classList.toggle('hidden', name !== 'workout');
  document.getElementById('view-history').classList.toggle('hidden', name !== 'history');

  document.getElementById('main').scrollTop = 0;

  if (name === 'home') renderHome();
  if (name === 'history') renderHistory();
  if (name === 'workout') {
    if (!activeWorkout) {
      // Auto-start today's suggestion when tapping Workout tab with nothing loaded
      startWorkout(getSuggestion().id);
    }
  }
}

// ─── Workout flow ──────────────────────────────────────────────────────────────

async function startWorkout(workoutId) {
  const wt = WORKOUT_TYPES.find(w => w.id === workoutId);
  if (!wt) return;

  activeWorkout = { type: wt, exercises: [] };
  showView('workout');
  renderWorkoutShell(wt);

  const exercises = await loadExercisesForWorkout(wt);
  activeWorkout.exercises = exercises;

  const done = todayEntry()?.workoutId === workoutId;
  renderExercises(exercises, wt, done);
}

function completeWorkout() {
  if (!activeWorkout) return;
  const btn = document.getElementById('btn-complete');
  if (btn.classList.contains('done')) return;

  const { type } = activeWorkout;
  addToHistory(type.id, type.name);

  btn.textContent = '✓ Completed Today';
  btn.classList.add('done');
  toast(`${type.emoji} ${type.name} logged!`);
}

// ─── Exercise detail modal ────────────────────────────────────────────────────

function openDetail(index) {
  if (!activeWorkout) return;
  const ex = activeWorkout.exercises[index];
  if (!ex) return;

  const el = document.createElement('div');
  el.className = 'modal-bg';
  el.innerHTML = `
    <div class="modal-box">
      <button class="modal-close" onclick="this.closest('.modal-bg').remove()">✕</button>
      ${ex.image ? `<img class="modal-img" src="${ex.image}" alt="${ex.name}">` : ''}
      <div class="modal-title">${ex.name}</div>
      <div class="modal-mus">${ex.muscles || ex.category}</div>
      ${ex.description ? `<div class="modal-desc">${ex.description}</div>` : ''}
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
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('show'));
  });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, 2800);
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('header-date').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  renderHome();
});
