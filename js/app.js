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
  try { localStorage.setItem('mtracker_lang', code); } catch { /* quota full — continue */ }

  document.querySelectorAll('.lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === code)
  );

  renderHeaderDate();

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
const CACHE_PFX   = 'mtracker_cache_v3_'; // bumped: old v2 cache had imageless API exercises

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function addToHistory(workoutId, dateStr) {
  const ds = dateStr || todayStr();
  const history = getHistory().filter(h => h.date !== ds);
  history.push({ date: ds, workoutId });
  history.sort((a, b) => b.date.localeCompare(a.date));
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 90))); }
  catch { /* storage quota exceeded — history won't persist this session */ }
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
  return Math.round((today - past) / 86400000);
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

function todayEntry() {
  return getHistory().find(h => h.date === todayStr()) || null;
}

function getSuggestion(history) {
  const hist     = history || getHistory();
  const todayEnt = hist.find(h => h.date === todayStr()) || null;
  if (todayEnt) return WORKOUT_TYPES.find(w => w.id === todayEnt.workoutId) || WORKOUT_TYPES[0];

  const scored = WORKOUT_TYPES.map(wt => {
    const last = hist.filter(h => h.workoutId === wt.id)
                     .sort((a, b) => b.date.localeCompare(a.date))[0];
    return { wt, score: last ? daysSince(last.date) : Infinity };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].wt;
}

// ─── API / caching ────────────────────────────────────────────────────────────

function getCached(catId) {
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
    try {
      localStorage.setItem(CACHE_PFX + catId, JSON.stringify({ data: withImages, ts: Date.now() }));
    } catch { /* quota exceeded — results used in-memory this session */ }

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
    <div class="ex-card" onclick="openDetail(${i})">
      <div class="ex-img-wrap">
        ${imgUrl
          ? `<img class="ex-img" src="${imgUrl}" alt="${name}" loading="eager"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        <div class="ex-placeholder" style="${imgUrl ? 'display:none' : ''};background:${wt.gradient}">
          <span style="font-size:36px">${icon}</span>
          <span class="ex-placeholder-name">${name}</span>
        </div>
        <div class="ex-num">${i + 1}</div>
        ${canRefresh ? `<button class="ex-refresh" onclick="event.stopPropagation();refreshExercise(${i})" aria-label="Swap exercise">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0012 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
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
      <div class="status-row" onclick="startWorkout('${sanitize(w.id)}')">
        <div class="status-left">
          <div class="status-dot" style="background:${w.color}"></div>
          <div>
            <div class="status-name">${sanitize(wtName(w))}</div>
            <div class="status-subs">${wtMuscles(w).map(sanitize).join(' · ')}</div>
          </div>
        </div>
        <div class="status-right">
          <span class="status-days ${cls}">${sanitize(label)}</span>
          <span class="status-chevron">›</span>
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

  grid.innerHTML = exercises.map((ex, i) => renderCard(ex, i, wt)).join('');

  if (btn) {
    btn.textContent = alreadyDone ? t('completedToday') : t('markComplete');
    btn.classList.toggle('done', alreadyDone);
  }
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

  // With no history show the last 7 days (all rest days, all tappable to log)
  const earliest = history.length ? history[history.length - 1].date : null;
  const maxDays  = history.length ? 21 : 7;
  const rows = [];
  for (let i = 0; i < maxDays; i++) {
    const d  = new Date();
    d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    if (earliest && ds < earliest) break; // don't pad rest days before first ever workout
    const entry = history.find(h => h.date === ds);
    const wt    = entry ? WORKOUT_TYPES.find(w => w.id === entry.workoutId) : null;

    if (entry && wt) {
      rows.push(`
        <div class="hist-item" onclick="openDayPicker('${ds}')">
          <div class="hist-bar" style="background:${wt.color}"></div>
          <div class="hist-info">
            <div class="hist-name">${sanitize(wtName(wt))}</div>
            <div class="hist-date">${sanitize(formatDate(ds))}</div>
          </div>
          <div class="hist-icon">${wt.emoji}</div>
          <span class="hist-chevron">›</span>
        </div>
      `);
    } else {
      rows.push(`
        <div class="hist-item" onclick="openDayPicker('${ds}')">
          <div class="hist-bar" style="background:var(--border)"></div>
          <div class="hist-info">
            <div class="hist-name rest-day">${sanitize(t('restDay'))}</div>
            <div class="hist-date">${sanitize(formatDate(ds))}</div>
          </div>
          <span class="hist-add">+</span>
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
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
  renderHistory();
}

function openDateSelector() {
  if (document.querySelector('.modal-bg')) return;

  const history = getHistory();

  const overlay = document.createElement('div');
  overlay.className = 'modal-bg';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const box = document.createElement('div');
  box.className = 'modal-box';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', close);
  box.appendChild(closeBtn);

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

  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

function openDayPicker(dateStr) {
  if (document.querySelector('.modal-bg')) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-bg';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const box = document.createElement('div');
  box.className = 'modal-box';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', close);
  box.appendChild(closeBtn);

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
      renderHistory();
      renderHome();
    });
    box.appendChild(btn);
  });

  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
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
  if (name === 'workout') {
    if (!activeWorkout) {
      startWorkout(getSuggestion().id);
    } else {
      // Re-check done state — may have changed via history date picker
      const done = todayEntry()?.workoutId === activeWorkout.type.id;
      const btn  = document.getElementById('btn-complete');
      if (btn) {
        btn.textContent = done ? t('completedToday') : t('markComplete');
        btn.classList.toggle('done', done);
      }
    }
  }
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

  const btn = document.getElementById('btn-complete');
  if (btn) {
    btn.textContent = t('markComplete');
    btn.classList.remove('done');
  }

  const exercises = await loadExercisesForWorkout(wt);

  // Guard: user may have tapped a different workout while this one was loading
  if (activeWorkout !== myWorkout) return;

  activeWorkout.exercises = exercises;
  const done = todayEntry()?.workoutId === workoutId;
  renderExercises(exercises, wt, done);
}

function completeWorkout() {
  if (!activeWorkout) return;
  const btn = document.getElementById('btn-complete');
  if (!btn || btn.classList.contains('done')) return;

  const { type } = activeWorkout;
  addToHistory(type.id);
  btn.textContent = t('completedToday');
  btn.classList.add('done');
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
  const overlay = document.createElement('div');
  overlay.className = 'modal-bg';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const box = document.createElement('div');
  box.className = 'modal-box';

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', close);
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

  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
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
  document.documentElement.lang = currentLang;

  // Remove stale cache entries from older app versions
  ['v1', 'v2'].forEach(v => {
    const pfx = `mtracker_cache_${v}_`;
    try {
      Object.keys(localStorage).filter(k => k.startsWith(pfx)).forEach(k => localStorage.removeItem(k));
    } catch {}
  });

  setAppHeight();
  window.addEventListener('resize', setAppHeight);
  window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 200));

  document.querySelectorAll('.lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === currentLang)
  );
  updateNavLabels();
  renderHeaderDate();
  renderHome();
  document.getElementById('header-date').addEventListener('click', openDateSelector);
}

// Works whether DOMContentLoaded already fired (inline scripts) or not (defer)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
