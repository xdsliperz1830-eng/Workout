'use strict';

// ─── Safe storage access ──────────────────────────────────────────────────────

// Safari with "Block All Cookies" throws a SecurityError on *any* localStorage
// access — including the property read itself, before getItem is even called.
// Every touch goes through these so a locked-down device degrades to an
// in-memory session instead of a blank screen.
function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* quota or blocked — skip */ }
}

function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { /* blocked — nothing to do */ }
}

// ─── State ────────────────────────────────────────────────────────────────────

let currentLang   = lsGet('mtracker_lang') || 'en';
let activeWorkout = null;   // { type, exercises }
let currentView   = 'home';

// ─── Security helpers ─────────────────────────────────────────────────────────

// HTML-encode any string before injecting into innerHTML
function sanitize(str) {
  const el = document.createElement('div');
  el.textContent = String(str == null ? '' : str);
  return el.innerHTML;
}

// sanitize() covers & < >, which is enough for text nodes. Values interpolated
// into a quoted attribute need the quotes escaped too or they can break out of
// the attribute.
function escapeAttr(str) {
  return sanitize(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Workout history is keyed by date, but meals and chat messages need their own
// identity — collision-resistant enough for a single-device log.
function createId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Modules loaded after this one (meals, nutrition assistant) register setup
// here; they all run once the DOM is parsed, before the first render.
const INIT_HOOKS = [];
function onInit(fn) { INIT_HOOKS.push(fn); }

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

// Map app language → BCP-47 locale for date/number formatting
const LOCALE_FOR = { en: 'en-US', es: 'es-ES', sq: 'sq-AL' };

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
  document.documentElement.lang = code;
  lsSet('mtracker_lang', code);

  document.querySelectorAll('.lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === code)
  );

  renderHeaderDate();

  if (currentView === 'home')    renderHome();
  if (currentView === 'meals')   renderMealsView();
  if (currentView === 'history') renderHistory();
  if (currentView === 'workout' && activeWorkout) {
    renderWorkoutHeader(activeWorkout.type);
    const done = todayEntry()?.workoutId === activeWorkout.type.id;
    renderExercises(activeWorkout.exercises, activeWorkout.type, done);
  }

  // The assistant's own labels are language-dependent too.
  renderAiConfig();
  renderAiChat();
  updateNavLabels();
}

function updateNavLabels() {
  const labels = document.querySelectorAll('.nav-btn span');
  const keys   = ['home', 'workout', 'meals', 'history'];
  labels.forEach((el, i) => { el.textContent = t(keys[i]); });
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'mtracker_history_v1';
const CACHE_PFX   = 'mtracker_cache_v3_'; // bumped: old v2 cache had imageless API exercises

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getHistory() {
  let parsed;
  try { parsed = JSON.parse(lsGet(HISTORY_KEY) || '[]'); }
  catch { return []; }
  // Valid JSON of the wrong shape (say an object) would sail past a parse-only
  // guard and then throw on the first .filter/.find, breaking every view — so
  // check the shape of the array and of each entry.
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(h =>
    h && typeof h.date === 'string' && DATE_RE.test(h.date) && typeof h.workoutId === 'string'
  );
}

function saveHistory(history) {
  lsSet(HISTORY_KEY, JSON.stringify(history.slice(0, 90)));
}

function addToHistory(workoutId, dateStr) {
  const today = todayStr();
  // Clamp to today: the pickers only offer past days, but a device clock or
  // timezone change can still hand us a future date. A stored future date
  // would render as a negative "days ago" on the home screen forever.
  const ds = (dateStr && dateStr <= today) ? dateStr : today;
  const history = getHistory().filter(h => h.date !== ds);
  history.push({ date: ds, workoutId });
  history.sort((a, b) => b.date.localeCompare(a.date));
  saveHistory(history);
}

function removeFromHistory(dateStr) {
  saveHistory(getHistory().filter(h => h.date !== dateStr));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

// Returns YYYY-MM-DD in the device's local timezone (not UTC)
function localDateStr(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr() { return localDateStr(); }

function daysSince(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const past  = new Date(y, m - 1, d);        // local midnight of that date
  const today = new Date();
  today.setHours(0, 0, 0, 0);                 // local midnight today
  // Math.round (not floor) absorbs the ±1h skew when a DST boundary falls
  // between the two dates. Math.max keeps the result non-negative so a stale
  // render or a backwards clock change can never print "-1 d ago".
  return Math.max(0, Math.round((today - past) / 86400000));
}

// Shift a YYYY-MM-DD string by whole days, staying in local time.
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return localDateStr(dt);
}

// Short localised weekday for chart axes. Anchored at noon so a DST shift can't
// tip the date onto the previous day.
function weekdayLabel(dateStr) {
  return new Date(dateStr + 'T12:00:00')
    .toLocaleDateString(LOCALE_FOR[currentLang] || 'en-US', { weekday: 'short' });
}

function formatDate(dateStr) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yest = localDateStr(yesterday);
  if (dateStr === todayStr()) return t('today');
  if (dateStr === yest)       return t('yesterday');
  return new Date(dateStr + 'T12:00:00').toLocaleDateString(LOCALE_FOR[currentLang] || 'en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderHeaderDate() {
  const dateStr = new Date().toLocaleDateString(LOCALE_FOR[currentLang] || 'en-US',
    { weekday: 'long', month: 'long', day: 'numeric' });
  document.getElementById('header-date').innerHTML =
    sanitize(dateStr) + '<span class="hd-cal"> 📅</span>';
}

// ─── Suggestion algorithm ─────────────────────────────────────────────────────

// Stand-in "days rested" for a workout that has never been logged. Must be a
// finite number: Infinity - Infinity is NaN, and a comparator that returns NaN
// leaves sort order implementation-defined, so the suggestion would jump around
// between renders whenever two or more workouts were never done.
const NEVER_DONE_SCORE = 1e9;

function todayEntry() {
  return getHistory().find(h => h.date === todayStr()) || null;
}

function getSuggestion(history) {
  const hist     = history || getHistory();
  const todayEnt = hist.find(h => h.date === todayStr()) || null;
  if (todayEnt) return WORKOUT_TYPES.find(w => w.id === todayEnt.workoutId) || WORKOUT_TYPES[0];

  const scored = WORKOUT_TYPES.map((wt, order) => {
    const last = hist.filter(h => h.workoutId === wt.id)
                     .sort((a, b) => b.date.localeCompare(a.date))[0];
    return { wt, order, score: last ? daysSince(last.date) : NEVER_DONE_SCORE };
  });
  // Longest-rested first; ties break on WORKOUT_TYPES order so repeated renders
  // always land on the same suggestion.
  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return scored[0].wt;
}

// ─── API / caching ────────────────────────────────────────────────────────────

function getCached(catId) {
  try {
    const raw = lsGet(CACHE_PFX + catId);
    if (raw) {
      const { data, ts } = JSON.parse(raw);
      if (Array.isArray(data) && Date.now() - ts < 48 * 3600 * 1000) return data;
    }
  } catch { /* corrupt entry — fall through and refetch */ }
  return null;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchCategory(catId) {
  const cached = getCached(catId);
  if (cached) return cached;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(
      `https://wger.de/api/v2/exerciseinfo/?format=json&language=2&category=${catId}&limit=80&offset=0`,
      { signal: controller.signal }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const json = await res.json();

    // wger language ID → ISO short code (covers the IDs we care about)
    const LANG_ID = { 1: 'de', 2: 'en', 3: 'bg', 4: 'es', 5: 'ru',
                      6: 'nl', 7: 'pt', 8: 'cs', 21: 'sq' };

    const exercises = json.results.map(ex => {
      // Build names + descriptions keyed by language short code.
      // wger may return `language` as a nested object {id, short_name}
      // OR as a plain integer ID — handle both.
      const names        = {};
      const descriptions = {};
      for (const tr of (ex.translations || [])) {
        const lang  = tr.language;
        const short = typeof lang === 'object'
          ? (lang?.short_name || LANG_ID[lang?.id])
          : LANG_ID[lang];
        if (short && tr.name?.trim()) {
          names[short] = tr.name.trim();
          const d = stripHtml(tr.description || '');
          if (d) descriptions[short] = d.slice(0, 300);
        }
      }
      // Some exerciseinfo responses include a top-level `name` field
      if (!names.en && ex.name?.trim()) names.en = ex.name.trim();
      // Fall back to any available translation rather than dropping the exercise
      if (!names.en) {
        const first = Object.values(names)[0];
        if (first) names.en = first; else return null;
      }

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

    // Cache and return only exercises with images — saves localStorage quota
    const withImages = exercises.filter(e => e.image);
    lsSet(CACHE_PFX + catId, JSON.stringify({ data: withImages, ts: Date.now() }));

    return withImages;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('API unavailable for category', catId, err);
    }
    return null; // triggers FALLBACK in caller
  } finally {
    clearTimeout(tid);
  }
}

// Return the best localised muscle string for an exercise
function exMuscles(ex) {
  if (ex.muscleNames) {
    return ex.muscleNames[currentLang] || ex.muscleNames.en || '';
  }
  // FALLBACK exercises store a plain English string — translate via lookup table
  const raw = ex.muscles || '';
  if (currentLang !== 'en' && MUSCLE_NAMES[raw]) {
    return MUSCLE_NAMES[raw][currentLang] || raw;
  }
  return raw;
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
  const result   = [];
  const fullPool = {};

  for (const cat of wt.categories) {
    // FALLBACK is the guaranteed image source — always included
    const fallback     = FALLBACK[cat.id] ?? [];
    const fallbackIds  = new Set(fallback.map(e => e.id));

    // Supplement with API exercises that actually carry an image (wger has sparse coverage)
    const live         = await fetchCategory(cat.id);
    const liveWithImg  = live ? live.filter(e => e.image) : [];
    const extras       = liveWithImg.filter(e => !fallbackIds.has(e.id));

    // Pool = all FALLBACK (verified images) + any API exercises with images
    const pool = [...fallback, ...extras];
    fullPool[cat.id] = pool;

    shuffle(pool).slice(0, cat.count).forEach(ex => result.push({ ...ex, catId: cat.id }));
  }

  // Top up to 8 from the first category's pool if needed
  if (result.length < 8) {
    const firstCat = wt.categories[0];
    for (const ex of (fullPool[firstCat.id] || [])) {
      if (result.length >= 8) break;
      if (!result.find(e => e.id === ex.id)) result.push({ ...ex, catId: firstCat.id });
    }
  }

  if (activeWorkout) activeWorkout.pool = fullPool;
  return result.slice(0, 8);
}

function refreshExercise(index) {
  if (!activeWorkout) return;
  const ex = activeWorkout.exercises[index];
  if (!ex) return;

  const catId    = ex.catId;
  const pool     = (activeWorkout.pool || {})[catId] || [];
  const usedIds  = new Set(activeWorkout.exercises.map(e => e.id));
  const candidates = pool.filter(e => !usedIds.has(e.id));
  if (!candidates.length) return;

  const next = candidates[Math.floor(Math.random() * candidates.length)];
  activeWorkout.exercises[index] = { ...next, catId };

  // Replace only the one card — avoids image flicker on the other 7
  const cards = document.getElementById('exercise-grid').querySelectorAll('.ex-card');
  if (cards[index]) {
    const tmp = document.createElement('div');
    tmp.innerHTML = renderCard(activeWorkout.exercises[index], index, activeWorkout.type);
    cards[index].replaceWith(tmp.firstElementChild);
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderCard(ex, i, wt) {
  const icon    = wt.icons[i % 4];
  const name    = sanitize(exName(ex));
  const muscles = sanitize(exMuscles(ex));
  const imgUrl  = safeUrl(ex.image || '');
  const proto   = ex.proto || wt.defaultProto;
  const protoStr = proto ? `${proto.sets}×${proto.reps}` : '';

  const pool       = (activeWorkout?.pool || {})[ex.catId] || [];
  const usedIds    = new Set((activeWorkout?.exercises || []).map(e => e.id));
  const canRefresh = pool.some(e => !usedIds.has(e.id));

  return `
    <div class="ex-card" role="button" tabindex="0" data-action="open-detail" data-arg="${i}">
      <div class="ex-img-wrap">
        ${imgUrl
          ? `<img class="ex-img" src="${imgUrl}" alt="${name}" loading="${i < 4 ? 'eager' : 'lazy'}">`
          : ''}
        <div class="ex-placeholder" style="${imgUrl ? 'display:none' : ''};background:${wt.gradient}">
          <span style="font-size:36px" aria-hidden="true">${icon}</span>
          <span class="ex-placeholder-name">${name}</span>
        </div>
        <div class="ex-num">${i + 1}</div>
        ${canRefresh ? `<button class="ex-refresh" data-action="refresh-ex" data-arg="${i}" aria-label="Swap exercise">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0012 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        </button>` : ''}
      </div>
      <div class="ex-info">
        <div class="ex-name">${name}</div>
        <div class="ex-mus">${muscles}</div>
        ${protoStr ? `<div class="ex-proto">${protoStr}</div>` : ''}
      </div>
    </div>
  `;
}

function renderHome() {
  const history  = getHistory();
  const todayEnt = history.find(h => h.date === todayStr()) || null;
  const wt       = getSuggestion(history);
  const done     = !!todayEnt;

  document.getElementById('label-today').textContent     = t('todaySuggestion');
  document.getElementById('label-status').textContent    = t('muscleStatus');
  document.getElementById('label-nutrition').textContent = t('todayNutrition');
  renderTodayNutrition();

  // Suggestion card — uses only hardcoded data; sanitize for defence-in-depth
  document.getElementById('suggestion-card').innerHTML = `
    <div class="s-card" style="background:${wt.gradient}">
      <span class="s-emoji" aria-hidden="true">${wt.emoji}</span>
      <div class="s-name">
        ${sanitize(wtName(wt))}
        ${done ? `<span class="done-badge">${sanitize(t('doneBadge'))}</span>` : ''}
      </div>
      <div class="s-desc">${sanitize(wtDesc(wt))}</div>
      <div class="s-tags">
        ${wtMuscles(wt).map(m => `<span class="s-tag">${sanitize(m)}</span>`).join('')}
        <span class="s-tag">8 ${sanitize(t('exercises'))}</span>
      </div>
      <button class="btn-start" data-action="start-workout" data-arg="${sanitize(wt.id)}">
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
      <div class="status-row" role="button" tabindex="0" data-action="start-workout" data-arg="${sanitize(w.id)}">
        <div class="status-left">
          <div class="status-dot" style="background:${w.color}" aria-hidden="true"></div>
          <div>
            <div class="status-name">${sanitize(wtName(w))}</div>
            <div class="status-subs">${wtMuscles(w).map(sanitize).join(' · ')}</div>
          </div>
        </div>
        <div class="status-right">
          <span class="status-days ${cls}">${sanitize(label)}</span>
          <span class="status-chevron" aria-hidden="true">›</span>
        </div>
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

// Single source of truth for the complete-button's label + state, so the
// "already logged today" check can't drift between the paths that set it.
function setCompleteBtn(done) {
  const btn = document.getElementById('btn-complete');
  if (!btn) return;
  btn.textContent = done ? t('completedToday') : t('markComplete');
  btn.classList.toggle('done', done);
}

function renderExercises(exercises, wt, alreadyDone) {
  const grid = document.getElementById('exercise-grid');

  if (!exercises.length) {
    grid.innerHTML = `
      <div class="loading-wrap">
        <div>⚠️ ${sanitize(t('noConnection'))}</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = exercises.map((ex, i) => renderCard(ex, i, wt)).join('');
  setCompleteBtn(alreadyDone);
}

function renderHistory() {
  document.getElementById('label-history').textContent = t('workoutHistory');
  const history   = getHistory();
  const container = document.getElementById('history-list');
  const clearBtn  = document.getElementById('btn-clear-history');
  const confirmEl = document.getElementById('hist-confirm');

  // Update localised button labels
  document.getElementById('btn-clear-label').textContent  = t('clearHistory');
  document.getElementById('hist-confirm-msg').textContent = t('clearConfirmMsg');
  document.getElementById('btn-cancel-clear').textContent = t('cancel');
  document.getElementById('btn-do-clear').textContent     = t('clearAll');

  // Reset confirm banner whenever history re-renders
  if (confirmEl) confirmEl.classList.add('hidden');

  if (clearBtn) clearBtn.style.display = history.length ? '' : 'none';

  // Nothing ever logged: show the empty state instead of seven identical
  // "Rest day" rows, keeping a way in to log a past workout.
  if (!history.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="big" aria-hidden="true">🏋️</div>
        <strong>${sanitize(t('noHistory'))}</strong>
        <span>${sanitize(t('noHistoryHint'))}</span>
        <button class="btn-empty-action" data-action="open-dates">${sanitize(t('selectDay'))}</button>
      </div>
    `;
    return;
  }

  // Derive the oldest date rather than trusting the array to be sorted — an
  // out-of-order entry would otherwise cut the list short via the break below.
  const earliest = history.reduce((min, h) => (h.date < min ? h.date : min), history[0].date);
  const rows = [];
  for (let i = 0; i < 21; i++) {
    const d  = new Date();
    d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    if (ds < earliest) break; // don't pad rest days before the first ever workout
    const entry = history.find(h => h.date === ds);
    const wt    = entry ? WORKOUT_TYPES.find(w => w.id === entry.workoutId) : null;

    if (entry && wt) {
      rows.push(`
        <div class="hist-item" role="button" tabindex="0" data-action="open-day" data-arg="${ds}">
          <div class="hist-bar" style="background:${wt.color}" aria-hidden="true"></div>
          <div class="hist-info">
            <div class="hist-name">${sanitize(wtName(wt))}</div>
            <div class="hist-date">${sanitize(formatDate(ds))}</div>
          </div>
          <div class="hist-icon" aria-hidden="true">${wt.emoji}</div>
          <span class="hist-chevron" aria-hidden="true">›</span>
        </div>
      `);
    } else {
      rows.push(`
        <div class="hist-item" role="button" tabindex="0" data-action="open-day" data-arg="${ds}">
          <div class="hist-bar" style="background:var(--border)" aria-hidden="true"></div>
          <div class="hist-info">
            <div class="hist-name rest-day">${sanitize(t('restDay'))}</div>
            <div class="hist-date">${sanitize(formatDate(ds))}</div>
          </div>
          <span class="hist-add" aria-hidden="true">+</span>
        </div>
      `);
    }
  }
  container.innerHTML = rows.join('');
}

function promptClearHistory() {
  const confirmEl = document.getElementById('hist-confirm');
  if (confirmEl) confirmEl.classList.remove('hidden');
  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) clearBtn.style.display = 'none';
}

function cancelClearHistory() {
  const confirmEl = document.getElementById('hist-confirm');
  if (confirmEl) confirmEl.classList.add('hidden');
  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) clearBtn.style.display = '';
}

function doClearHistory() {
  lsRemove(HISTORY_KEY);
  renderHistory();
  renderHome();
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// Shared modal shell: builds the overlay, wires Escape and backdrop close, traps
// Tab inside the dialog, and hands focus back to whatever opened it on close.
function openModal(label) {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'modal-bg';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  if (label) overlay.setAttribute('aria-label', label);

  const box = document.createElement('div');
  box.className = 'modal-box';
  overlay.appendChild(box);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && document.contains(opener)) opener.focus();
  };

  const onKey = e => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last  = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);

  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', close);
  box.appendChild(closeBtn);

  return {
    box,
    close,
    show() {
      document.body.appendChild(overlay);
      const first = box.querySelector(FOCUSABLE);
      if (first) first.focus();
    },
  };
}

function openDateSelector() {
  if (document.querySelector('.modal-bg')) return;

  const history = getHistory();
  const { box, close, show } = openModal(t('selectDay'));

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.style.marginBottom = '16px';
  title.textContent = t('selectDay');
  box.appendChild(title);

  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = localDateStr(d);

    const entry = history.find(h => h.date === ds);
    const wt    = entry ? WORKOUT_TYPES.find(w => w.id === entry.workoutId) : null;

    const row = document.createElement('button');
    row.className = 'date-sel-row';

    const bar = document.createElement('span');
    bar.className = 'date-sel-bar';
    bar.style.background = wt ? wt.color : 'var(--border)';

    const info = document.createElement('div');
    info.className = 'date-sel-info';

    const dateLabel = document.createElement('div');
    dateLabel.className = 'date-sel-date';
    dateLabel.textContent = formatDate(ds);

    const statusLabel = document.createElement('div');
    statusLabel.className = 'date-sel-status';
    statusLabel.textContent = wt ? wtName(wt) : t('restDay');
    if (!wt) statusLabel.style.fontStyle = 'italic';

    info.appendChild(dateLabel);
    info.appendChild(statusLabel);

    const right = document.createElement('span');
    right.className = 'date-sel-right';
    right.textContent = wt ? wt.emoji : '+';

    row.appendChild(bar);
    row.appendChild(info);
    row.appendChild(right);

    row.addEventListener('click', () => {
      close();
      openDayPicker(ds);
    });
    box.appendChild(row);
  }

  show();
}

function openDayPicker(dateStr) {
  if (document.querySelector('.modal-bg')) return;

  const { box, close, show } = openModal(t('logFor'));

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = t('logFor');
  box.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'modal-mus';
  sub.style.marginBottom = '16px';
  sub.textContent = formatDate(dateStr);
  box.appendChild(sub);

  WORKOUT_TYPES.forEach(wt => {
    const btn = document.createElement('button');
    btn.className = 'day-picker-btn';

    const dot = document.createElement('span');
    dot.className = 'dp-dot';
    dot.style.background = wt.color;

    const info = document.createElement('div');
    info.className = 'dp-info';

    const name = document.createElement('div');
    name.className = 'dp-name';
    name.textContent = wtName(wt);

    const mus = document.createElement('div');
    mus.className = 'dp-muscles';
    mus.textContent = wtMuscles(wt).join(' · ');

    info.appendChild(name);
    info.appendChild(mus);

    const emoji = document.createElement('span');
    emoji.className = 'dp-emoji';
    emoji.textContent = wt.emoji;

    btn.appendChild(dot);
    btn.appendChild(info);
    btn.appendChild(emoji);

    btn.addEventListener('click', () => {
      addToHistory(wt.id, dateStr);
      close();
      afterHistoryChange();
    });
    box.appendChild(btn);
  });

  // Clearing a single day used to be impossible — the only way to undo a
  // mis-logged workout was wiping the entire history.
  if (getHistory().some(h => h.date === dateStr)) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'day-picker-btn';

    const dot = document.createElement('span');
    dot.className = 'dp-dot';
    dot.style.background = 'var(--border)';

    const info = document.createElement('div');
    info.className = 'dp-info';
    const name = document.createElement('div');
    name.className = 'dp-name rest-day';
    name.textContent = t('restDay');
    info.appendChild(name);

    const mark = document.createElement('span');
    mark.className = 'dp-emoji';
    mark.textContent = '✕';

    clearBtn.appendChild(dot);
    clearBtn.appendChild(info);
    clearBtn.appendChild(mark);

    clearBtn.addEventListener('click', () => {
      removeFromHistory(dateStr);
      close();
      afterHistoryChange();
    });
    box.appendChild(clearBtn);
  }

  show();
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function showView(name) {
  currentView = name;
  document.querySelectorAll('.nav-btn').forEach(b => {
    const isActive = b.dataset.view === name;
    b.classList.toggle('active', isActive);
    if (isActive) b.setAttribute('aria-current', 'page');
    else         b.removeAttribute('aria-current');
  });
  document.getElementById('view-home').classList.toggle('hidden',    name !== 'home');
  document.getElementById('view-workout').classList.toggle('hidden', name !== 'workout');
  document.getElementById('view-meals').classList.toggle('hidden',   name !== 'meals');
  document.getElementById('view-history').classList.toggle('hidden', name !== 'history');
  document.getElementById('main').scrollTop = 0;

  if (name === 'home')    renderHome();
  if (name === 'meals')   renderMealsView();
  if (name === 'history') renderHistory();
  if (name === 'workout') {
    if (!activeWorkout) {
      startWorkout(getSuggestion().id);
    } else {
      // Re-check done state — may have changed via history date picker
      setCompleteBtn(todayEntry()?.workoutId === activeWorkout.type.id);
    }
  }
}

// Bring the visible view back in sync with the current date/history. iOS Safari
// keeps the DOM alive across backgrounding, so a page opened yesterday would
// otherwise keep showing yesterday's "days ago" labels indefinitely.
function refreshCurrentView() {
  renderHeaderDate();
  if (currentView === 'home')    renderHome();
  if (currentView === 'meals')   renderMealsView();
  if (currentView === 'history') renderHistory();
  if (currentView === 'workout' && activeWorkout) {
    setCompleteBtn(todayEntry()?.workoutId === activeWorkout.type.id);
  }
}

// Re-render everything that reads history after a day is logged or cleared. The
// changed day may be today, which also flips the complete-button state.
function afterHistoryChange() {
  renderHistory();
  renderHome();
  if (activeWorkout) setCompleteBtn(todayEntry()?.workoutId === activeWorkout.type.id);
}

// ─── Workout flow ──────────────────────────────────────────────────────────────

async function startWorkout(workoutId) {
  const wt = WORKOUT_TYPES.find(w => w.id === workoutId);
  if (!wt) return;

  const myWorkout = { type: wt, exercises: [] };
  activeWorkout = myWorkout;
  showView('workout');
  renderWorkoutHeader(wt);

  document.getElementById('exercise-grid').innerHTML = `
    <div class="loading-wrap">
      <div class="spinner"></div>
      <div>${sanitize(t('loading'))}</div>
    </div>
  `;

  setCompleteBtn(todayEntry()?.workoutId === workoutId);

  const exercises = await loadExercisesForWorkout(wt);

  // Guard: user may have tapped a different workout while this one was loading
  if (activeWorkout !== myWorkout) return;

  activeWorkout.exercises = exercises;
  renderExercises(exercises, wt, todayEntry()?.workoutId === workoutId);
}

function completeWorkout() {
  if (!activeWorkout) return;
  const btn = document.getElementById('btn-complete');
  if (!btn || btn.classList.contains('done')) return;

  const { type } = activeWorkout;
  addToHistory(type.id);
  setCompleteBtn(true);
  toast(`${type.emoji} ${wtName(type)}`);
}

// ─── Exercise detail modal ────────────────────────────────────────────────────

function openDetail(index) {
  if (!activeWorkout) return;
  if (document.querySelector('.modal-bg')) return;
  const ex = activeWorkout.exercises[index];
  if (!ex) return;

  const name    = exName(ex);
  const muscles = exMuscles(ex);
  const desc    = exDesc(ex);
  const imgs    = ex.allImages || (ex.image ? [ex.image] : []);

  // Build modal with DOM API to avoid any innerHTML injection risk for dynamic content
  const { box, show } = openModal(name);

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

  // Proto box (sets / reps / rest)
  const proto = ex.proto || activeWorkout.type.defaultProto;
  if (proto) {
    const pb = document.createElement('div');
    pb.className = 'proto-box';
    [
      { val: String(proto.sets),              lbl: t('sets') },
      { val: String(proto.reps),              lbl: t('reps') },
      { val: proto.rest + ' ' + t('sec'),     lbl: t('rest') },
    ].forEach(item => {
      const col = document.createElement('div');
      const val = document.createElement('div');
      val.className = 'proto-item-val';
      val.textContent = item.val;
      const lbl = document.createElement('div');
      lbl.className = 'proto-item-lbl';
      lbl.textContent = item.lbl;
      col.appendChild(val);
      col.appendChild(lbl);
      pb.appendChild(col);
    });
    box.appendChild(pb);
  }

  // Description
  if (desc) {
    const d = document.createElement('div');
    d.className = 'modal-desc';
    d.textContent = desc;
    box.appendChild(d);
  }

  show();
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status'); // announce completion to screen readers
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

// ─── Event delegation ─────────────────────────────────────────────────────────

// Every interactive element carries data-action instead of an inline onclick:
// inline handlers would force 'unsafe-inline' into script-src, which is exactly
// the protection worth keeping against injected markup from the exercise API.
const ACTIONS = {
  'set-lang':      arg => setLang(arg),
  'show-view':     arg => showView(arg),
  'start-workout': arg => startWorkout(arg),
  'open-detail':   arg => openDetail(Number(arg)),
  'refresh-ex':    arg => refreshExercise(Number(arg)),
  'open-day':      arg => openDayPicker(arg),
  'open-dates':    ()  => openDateSelector(),
  'complete':      ()  => completeWorkout(),
  'clear-prompt':  ()  => promptClearHistory(),
  'clear-cancel':  ()  => cancelClearHistory(),
  'clear-do':      ()  => doClearHistory(),
};

function runAction(e) {
  // closest() means the refresh button wins over the card it sits inside, so
  // swapping an exercise no longer needs to stop propagation by hand.
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  fn(el.dataset.arg);
}

// ─── Init ──────────────────────────────────────────────────────────────────────

function init() {
  document.documentElement.lang = currentLang;

  // Remove stale cache entries from older app versions
  ['v1', 'v2'].forEach(v => {
    const pfx = `mtracker_cache_${v}_`;
    try {
      Object.keys(localStorage).filter(k => k.startsWith(pfx)).forEach(k => lsRemove(k));
    } catch { /* storage blocked — nothing to clean up */ }
  });

  const app = document.getElementById('app');
  app.addEventListener('click', runAction);
  app.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'BUTTON') return; // native buttons already do this
    runAction(e);
  });

  // Error events on <img> don't bubble, so catch them in the capture phase and
  // reveal the gradient placeholder behind the broken image.
  document.getElementById('exercise-grid').addEventListener('error', e => {
    const img = e.target;
    if (img.tagName !== 'IMG') return;
    img.style.display = 'none';
    const placeholder = img.nextElementSibling;
    if (placeholder) placeholder.style.display = 'flex';
  }, true);

  // Cache the app shell so a home-screen launch still opens without a signal.
  if ('serviceWorker' in navigator) {
    const register = () => navigator.serviceWorker.register('sw.js')
      .catch(err => console.warn('Service worker registration failed', err));
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  setAppHeight();
  window.addEventListener('resize', setAppHeight);
  window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 200));

  // Re-sync whenever the app returns to the foreground, and on bfcache restore
  // (iOS back-swipe), which fires pageshow but not visibilitychange.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshCurrentView();
  });
  window.addEventListener('pageshow', e => { if (e.persisted) refreshCurrentView(); });

  // Catch the midnight rollover while the app is sitting open in the foreground
  let lastSeenDay = todayStr();
  setInterval(() => {
    const now = todayStr();
    if (now !== lastSeenDay) {
      lastSeenDay = now;
      refreshCurrentView();
    }
  }, 60000);

  document.querySelectorAll('.lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === currentLang)
  );
  updateNavLabels();
  renderHeaderDate();
}

function boot() {
  init();
  INIT_HOOKS.forEach(fn => fn());
  showView('home');
}

// Deferred scripts all run before DOMContentLoaded fires, so waiting for it is
// what guarantees meals.js and nutrition-ai.js have registered their hooks.
if (document.readyState === 'complete') boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });
