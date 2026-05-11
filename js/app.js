'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let currentLang   = localStorage.getItem('mtracker_lang') || 'en';
let activeWorkout = null;   // { type, exercises }
let currentView   = 'home';

// ─── Security helpers ─────────────────────────────────────────────────────────

// HTML-encode any string before injecting into innerHTML
function sanitize(str) {
  const el = document.createElement('div');
  el.textContent = String(str == null ? '' : str);
  return el.innerHTML;
}

// Only allow https:// URLs sourced from the wger API; reject anything else
function safeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

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
  try { localStorage.setItem('mtracker_lang', code); } catch { /* quota full — continue */ }

  document.querySelectorAll('.lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === code)
  );

  if (currentView === 'home')    renderHome();
  if (currentView === 'history') renderHistory();
  if (currentView === 'workout' && activeWorkout) {
    renderWorkoutHeader(activeWorkout.type);
    const done = todayEntry()?.workoutId === activeWorkout.type.id;
    renderExercises(activeWorkout.exercises, activeWorkout.type, done);
  }

  updateNavLabels();
}

function updateNavLabels() {
  const labels = document.querySelectorAll('.nav-btn span');
  const keys   = ['home', 'workout', 'history'];
  labels.forEach((el, i) => { el.textContent = t(keys[i]); });
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'mtracker_history_v1';
const CACHE_PFX   = 'mtracker_cache_v2_';

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function addToHistory(workoutId, workoutName) {
  const history = getHistory().filter(h => h.date !== todayStr());
  history.unshift({ date: todayStr(), workoutId, workoutName });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 90))); }
  catch { /* storage quota exceeded — history won't persist this session */ }
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

  // Abort after 10 s to avoid hanging indefinitely
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(
      `https://wger.de/api/v2/exerciseinfo/?format=json&language=2&category=${catId}&limit=80&offset=0`,
      { signal: controller.signal }
    );
    clearTimeout(tid);
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const json = await res.json();

    const exercises = json.results.map(ex => {
      // Build names + descriptions keyed by language short code
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
      if (!names.en) return null; // skip if no English name at all

      // Muscle names: wger provides name_en; also map localised names where the
      // API field exists (name_es, name_de, …). Albanian (sq) not provided by
      // wger so it falls back to English on display.
      const muscleNames = {};
      const muscleList  = ex.muscles || [];
      ['en', 'es', 'de', 'pt'].forEach(lang => {
        const key = `name_${lang}`;
        const joined = muscleList.map(m => m[key]).filter(Boolean).join(', ');
        if (joined) muscleNames[lang] = joined;
      });
      // Fallback: always have English
      if (!muscleNames.en) {
        muscleNames.en = muscleList.map(m => m.name_en).filter(Boolean).join(', ')
                      || ex.category?.name || '';
      }

      return {
        id:           ex.id,
        names,
        descriptions,
        // Validate all image URLs to https:// before storing
        image:        safeUrl(ex.images?.find(i => i.is_main)?.image || ex.images?.[0]?.image || ''),
        allImages:    (ex.images || []).map(i => safeUrl(i.image)).filter(Boolean),
        muscleNames,  // localised per language
        muscles:      muscleNames.en, // plain English string kept for backwards compat
      };
    }).filter(Boolean);

    // Exercises with photos first — maximises image coverage in each workout
    exercises.sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));

    try {
      localStorage.setItem(CACHE_PFX + catId, JSON.stringify({ data: exercises, ts: Date.now() }));
    } catch { /* quota exceeded — results used in-memory this session */ }

    return exercises;
  } catch (err) {
    clearTimeout(tid);
    if (err.name !== 'AbortError') {
      console.warn('API unavailable for category', catId, err);
    }
    return null; // triggers FALLBACK in caller
  }
}

// Return the best localised muscle string for an exercise
function exMuscles(ex) {
  if (ex.muscleNames) {
    return ex.muscleNames[currentLang] || ex.muscleNames.en || '';
  }
  return ex.muscles || ''; // fallback exercises only have a plain string
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
  const result      = [];
  const fetchedPool = {}; // keep fetched data to avoid duplicate API calls

  for (const cat of wt.categories) {
    const live = await fetchCategory(cat.id);
    const pool = live ?? FALLBACK[cat.id] ?? [];
    fetchedPool[cat.id] = pool;

    const withImg    = pool.filter(e => e.image);
    const withoutImg = pool.filter(e => !e.image);
    const ordered    = [...shuffle(withImg), ...shuffle(withoutImg)];
    result.push(...ordered.slice(0, cat.count));
  }

  // Top up to 8 using already-fetched pool (no extra API call)
  if (result.length < 8) {
    const pool = fetchedPool[wt.categories[0].id] || [];
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

  document.getElementById('label-today').textContent  = t('todaySuggestion');
  document.getElementById('label-status').textContent = t('muscleStatus');

  // Suggestion card — uses only hardcoded data; sanitize for defence-in-depth
  document.getElementById('suggestion-card').innerHTML = `
    <div class="s-card" style="background:${wt.gradient}">
      <span class="s-emoji">${wt.emoji}</span>
      <div class="s-name">
        ${sanitize(wtName(wt))}
        ${done ? `<span class="done-badge">${sanitize(t('doneBadge'))}</span>` : ''}
      </div>
      <div class="s-desc">${sanitize(wtDesc(wt))}</div>
      <div class="s-tags">
        ${wtMuscles(wt).map(m => `<span class="s-tag">${sanitize(m)}</span>`).join('')}
        <span class="s-tag">8 ${sanitize(t('exercises'))}</span>
      </div>
      <button class="btn-start" onclick="startWorkout('${sanitize(wt.id)}')">
        ${sanitize(done ? t('viewAgain') : t('startWorkout'))}
      </button>
    </div>
  `;

  // Muscle status — uses only hardcoded data
  document.getElementById('muscle-status').innerHTML = WORKOUT_TYPES.map(w => {
    const last = history.filter(h => h.workoutId === w.id)
                        .sort((a, b) => b.date.localeCompare(a.date))[0];
    let label = t('neverDone'), cls = '';
    if (last) {
      const d = daysSince(last.date);
      if (d === 0)      { label = t('today');                    cls = 'fresh';  }
      else if (d === 1) { label = t('yesterday');                cls = 'medium'; }
      else              { label = `${d} ${t('dAgo')}`;          cls = d <= 2 ? 'medium' : 'ripe'; }
    }
    return `
      <div class="status-row">
        <div class="status-left">
          <div class="status-dot" style="background:${w.color}"></div>
          <div>
            <div class="status-name">${sanitize(wtName(w))}</div>
            <div class="status-subs">${wtMuscles(w).map(sanitize).join(' · ')}</div>
          </div>
        </div>
        <div class="status-days ${cls}">${sanitize(label)}</div>
      </div>
    `;
  }).join('');
}

function renderWorkoutHeader(wt) {
  document.getElementById('workout-header').innerHTML = `
    <div class="wkt-header">
      <h2>${wt.emoji} ${sanitize(wtName(wt))}</h2>
      <p>${sanitize(wtDesc(wt))} · 8 ${sanitize(t('exercises'))}</p>
    </div>
  `;
}

function renderExercises(exercises, wt, alreadyDone) {
  const grid = document.getElementById('exercise-grid');
  const btn  = document.getElementById('btn-complete');

  if (!exercises.length) {
    grid.innerHTML = `
      <div class="loading-wrap">
        <div>⚠️ ${sanitize(t('noConnection'))}</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = exercises.map((ex, i) => {
    const icon    = wt.icons[i % 4];
    const name    = sanitize(exName(ex));
    const muscles = sanitize(exMuscles(ex));
    const imgUrl  = safeUrl(ex.image || '');

    return `
      <div class="ex-card" onclick="openDetail(${i})">
        <div class="ex-img-wrap">
          ${imgUrl
            ? `<img class="ex-img" src="${imgUrl}" alt="${name}" loading="lazy"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : ''}
          <div class="ex-placeholder" style="${imgUrl ? 'display:none' : ''};background:${wt.gradient}">
            <span style="font-size:36px">${icon}</span>
            <span class="ex-placeholder-name">${name}</span>
          </div>
          <div class="ex-num">${i + 1}</div>
        </div>
        <div class="ex-info">
          <div class="ex-name">${name}</div>
          <div class="ex-mus">${muscles}</div>
        </div>
      </div>
    `;
  }).join('');

  if (btn) {
    btn.textContent = alreadyDone ? t('completedToday') : t('markComplete');
    btn.classList.toggle('done', alreadyDone);
  }
}

function renderHistory() {
  document.getElementById('label-history').textContent = t('workoutHistory');
  const history   = getHistory();
  const container = document.getElementById('history-list');

  if (!history.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="big">📝</div>
        <strong>${sanitize(t('noHistory'))}</strong>
        <div>${sanitize(t('noHistoryHint'))}</div>
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
            <div class="hist-name">${sanitize(wtName(wt))}</div>
            <div class="hist-date">${sanitize(formatDate(ds))}</div>
          </div>
          <div class="hist-icon">${wt.emoji}</div>
        </div>
      `);
    } else {
      rows.push(`
        <div class="hist-item">
          <div class="hist-bar" style="background:var(--border)"></div>
          <div class="hist-info">
            <div class="hist-name rest-day">${sanitize(t('restDay'))}</div>
            <div class="hist-date">${sanitize(formatDate(ds))}</div>
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

  document.getElementById('exercise-grid').innerHTML = `
    <div class="loading-wrap">
      <div class="spinner"></div>
      <div>${sanitize(t('loading'))}</div>
    </div>
  `;

  const btn = document.getElementById('btn-complete');
  if (btn) {
    btn.textContent = t('markComplete');
    btn.classList.remove('done');
  }

  const exercises     = await loadExercisesForWorkout(wt);
  activeWorkout.exercises = exercises;

  const done = todayEntry()?.workoutId === workoutId;
  renderExercises(exercises, wt, done);
}

function completeWorkout() {
  if (!activeWorkout) return;
  const btn = document.getElementById('btn-complete');
  if (!btn || btn.classList.contains('done')) return;

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

  const name    = exName(ex);
  const muscles = exMuscles(ex);
  const desc    = exDesc(ex);
  const imgs    = ex.allImages || (ex.image ? [ex.image] : []);

  // Build modal with DOM API to avoid any innerHTML injection risk for dynamic content
  const overlay = document.createElement('div');
  overlay.className = 'modal-bg';

  const box = document.createElement('div');
  box.className = 'modal-box';

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  box.appendChild(closeBtn);

  // Image (or placeholder)
  if (imgs.length && safeUrl(imgs[0])) {
    const img = document.createElement('img');
    img.className = 'modal-img';
    img.alt = name;
    img.loading = 'lazy';
    // If primary image fails, try the second one; then give up
    let fallbackIdx = 1;
    img.addEventListener('error', () => {
      const next = safeUrl(imgs[fallbackIdx] || '');
      if (next && fallbackIdx < imgs.length) {
        fallbackIdx++;
        img.src = next;
      } else {
        img.style.display = 'none';
      }
    });
    img.src = safeUrl(imgs[0]);
    box.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'modal-img-placeholder';
    ph.style.background = activeWorkout.type.gradient;
    ph.textContent = activeWorkout.type.emoji;
    box.appendChild(ph);
  }

  // Title
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = name;
  box.appendChild(title);

  // Muscles
  if (muscles) {
    const mus = document.createElement('div');
    mus.className = 'modal-mus';
    mus.textContent = muscles;
    box.appendChild(mus);
  }

  // Description
  if (desc) {
    const d = document.createElement('div');
    d.className = 'modal-desc';
    d.textContent = desc;
    box.appendChild(d);
  }

  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg; // textContent — never innerHTML
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 2800);
}

// ─── iOS viewport height ──────────────────────────────────────────────────────

// iOS Safari's address bar changes the viewport height when scrolling.
// Reading window.innerHeight and storing it as a CSS variable gives a stable,
// accurate height that won't cause content to be clipped or overflow.
function setAppHeight() {
  document.documentElement.style.setProperty('--app-h', window.innerHeight + 'px');
}

// ─── Init ──────────────────────────────────────────────────────────────────────

function init() {
  setAppHeight();
  window.addEventListener('resize', setAppHeight);
  window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 200));

  document.querySelectorAll('.lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === currentLang)
  );
  updateNavLabels();
  renderHome();
}

// Works whether DOMContentLoaded already fired (inline scripts) or not (defer)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
