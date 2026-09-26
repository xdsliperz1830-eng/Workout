'use strict';

// ─── Meal tracking ────────────────────────────────────────────────────────────
//
// Ported from the standalone Meal Tracker app. The storage keys are deliberately
// unchanged: both apps were served from the same origin
// (xdsliperz1830-eng.github.io), and localStorage is keyed by origin rather than
// path, so an existing meal log is already present here — no migration needed.

const MEALS_KEY = 'mealtracker.meals.v1';
const GOAL_KEY  = 'mealtracker.goal.v1';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

// Day the Meals view is showing; also the day new meals are logged to.
let mealDate = todayStr();

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadMeals() {
  let parsed;
  try { parsed = JSON.parse(lsGet(MEALS_KEY) || '[]'); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(m =>
    m && typeof m.date === 'string' && DATE_RE.test(m.date) && typeof m.name === 'string'
  );
}

function saveMeals(meals) {
  lsSet(MEALS_KEY, JSON.stringify(meals));
}

function loadGoal() {
  const n = Number(lsGet(GOAL_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function saveGoal(n) {
  if (n > 0) lsSet(GOAL_KEY, String(n));
  else lsRemove(GOAL_KEY);
}

// ─── Maths / formatting ───────────────────────────────────────────────────────

function mealTotals(meals, date) {
  return meals
    .filter(m => m.date === date)
    .reduce((acc, m) => {
      const s = Number(m.servings) || 1;
      acc.calories += (Number(m.calories) || 0) * s;
      acc.protein  += (Number(m.protein)  || 0) * s;
      acc.carbs    += (Number(m.carbs)    || 0) * s;
      acc.fat       += (Number(m.fat)     || 0) * s;
      return acc;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

function num(n, places = 0) {
  if (!Number.isFinite(n)) n = 0;
  const f = Math.pow(10, places);
  const r = Math.round(n * f) / f;
  return Number.isInteger(r) ? String(r) : r.toFixed(places);
}

function mealTypeLabel(type) {
  return MEAL_TYPES.includes(type) ? t(type) : t('snack');
}

// ─── Home dashboard summary ───────────────────────────────────────────────────

// Compact nutrition block shown on the Home view beside the workout suggestion.
function renderTodayNutrition() {
  const el = document.getElementById('today-nutrition');
  if (!el) return;

  const today  = todayStr();
  const totals = mealTotals(loadMeals(), today);
  const goal   = loadGoal();

  const pct  = goal > 0 ? Math.min(100, (totals.calories / goal) * 100) : 0;
  const over = goal > 0 && totals.calories > goal;

  let status;
  if (goal > 0) {
    status = over
      ? `${sanitize(t('overBy'))} ${num(totals.calories - goal)} ${sanitize(t('kcal'))}`
      : `${num(goal - totals.calories)} ${sanitize(t('kcal'))} ${sanitize(t('remaining'))}`;
  } else {
    status = sanitize(t('goalPrompt'));
  }

  el.innerHTML = `
    <div class="nut-card" role="button" tabindex="0" data-action="show-view" data-arg="meals">
      <div class="nut-top">
        <div class="nut-kcal">
          <span class="nut-kcal-val">${num(totals.calories)}</span>
          <span class="nut-kcal-unit">${sanitize(t('kcal'))}${goal > 0 ? ` / ${goal}` : ''}</span>
        </div>
        <span class="nut-status ${over ? 'over' : ''}">${status}</span>
      </div>
      ${goal > 0 ? `<div class="progress"><div class="progress-bar${over ? ' over' : ''}" style="width:${pct}%"></div></div>` : ''}
      <div class="nut-macros">
        <span><strong>${num(totals.protein)}${sanitize(t('grams'))}</strong> ${sanitize(t('protein'))}</span>
        <span><strong>${num(totals.carbs)}${sanitize(t('grams'))}</strong> ${sanitize(t('carbs'))}</span>
        <span><strong>${num(totals.fat)}${sanitize(t('grams'))}</strong> ${sanitize(t('fat'))}</span>
      </div>
    </div>
  `;
}

// ─── Meals view ───────────────────────────────────────────────────────────────

function renderMealsView() {
  const meals = loadMeals();

  // Static labels
  setText('label-add-meal',    t('addMeal'));
  setText('label-meal-totals', t('dailyTotals'));
  setText('label-logged',      t('loggedMeals'));
  setText('label-week-nut',    t('weekNutrition'));
  setText('label-meal-data',   t('dataSection'));
  setText('label-assistant',   t('assistant'));
  setText('hint-assistant',    t('assistantHint'));
  setText('btn-add-meal',      t('addMealBtn'));
  setText('btn-export-label',  t('exportCsv'));
  setText('btn-import-label',  t('importCsv'));

  const goalInput = document.getElementById('meal-goal');
  goalInput.placeholder = t('dailyGoal');
  const goal = loadGoal();
  if (goal > 0 && goalInput.value === '') goalInput.value = goal;

  renderMealForm();
  renderMealDateBar();
  renderMealTotals(meals);
  renderMealList(meals);
  renderWeekNutrition(meals);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// The add-meal form's labels and meal-type options are language-dependent.
function renderMealForm() {
  const form = document.getElementById('meal-form');
  if (!form) return;

  form.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  form.elements.name.placeholder = t('foodNamePlace');

  const select = form.elements.type;
  const keep = select.value;
  select.innerHTML = MEAL_TYPES
    .map(v => `<option value="${v}">${sanitize(t(v))}</option>`)
    .join('');
  select.value = keep && MEAL_TYPES.includes(keep) ? keep : defaultMealType();
}

// Guess from the clock so the common case needs no interaction.
function defaultMealType() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

function renderMealDateBar() {
  const el = document.getElementById('meal-date-label');
  if (el) el.textContent = formatDate(mealDate);
  const input = document.getElementById('meal-date');
  if (input) input.value = mealDate;
}

function renderMealTotals(meals) {
  const totals = mealTotals(meals, mealDate);
  const goal   = loadGoal();

  document.getElementById('meal-totals').innerHTML = [
    [num(totals.calories), t('kcal')],
    [num(totals.protein) + t('grams'), t('protein')],
    [num(totals.carbs)   + t('grams'), t('carbs')],
    [num(totals.fat)     + t('grams'), t('fat')],
  ].map(([val, lbl]) => `
    <div>
      <span class="stat-val">${sanitize(val)}</span>
      <span class="stat-lbl">${sanitize(lbl)}</span>
    </div>
  `).join('');

  const bar    = document.getElementById('meal-goal-bar');
  const status = document.getElementById('meal-goal-status');
  if (goal > 0) {
    const over = totals.calories > goal;
    bar.style.width = Math.min(100, (totals.calories / goal) * 100) + '%';
    bar.classList.toggle('over', over);
    status.textContent = over
      ? `${t('overBy')} ${num(totals.calories - goal)} ${t('kcal')}`
      : `${num(totals.calories)} / ${goal} ${t('kcal')} · ${num(goal - totals.calories)} ${t('remaining')}`;
  } else {
    bar.style.width = '0%';
    bar.classList.remove('over');
    status.textContent = t('goalPrompt');
  }
}

function renderMealList(meals) {
  const container = document.getElementById('meal-list');
  const dayMeals  = meals
    .filter(m => m.date === mealDate)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  if (!dayMeals.length) {
    container.innerHTML = `
      <div class="empty-state small">
        <div class="big" aria-hidden="true">🍽️</div>
        <strong>${sanitize(t('noMeals'))}</strong>
        <span>${sanitize(t('noMealsHint'))}</span>
      </div>
    `;
    return;
  }

  container.innerHTML = dayMeals.map(m => {
    const s = Number(m.servings) || 1;
    const macros =
      `${num(m.calories * s)} ${t('kcal')} · ` +
      `${num(m.protein * s)}${t('grams')} ${t('protein')} · ` +
      `${num(m.carbs * s)}${t('grams')} ${t('carbs')} · ` +
      `${num(m.fat * s)}${t('grams')} ${t('fat')}` +
      (s !== 1 ? ` · ×${num(s, 2)}` : '');
    return `
      <div class="meal-item" role="button" tabindex="0" data-action="meal-edit" data-arg="${sanitize(m.id)}">
        <div class="meal-info">
          <div class="meal-name">
            <span class="meal-type">${sanitize(mealTypeLabel(m.type))}</span>${sanitize(m.name)}
          </div>
          <div class="meal-macros">${sanitize(macros)}</div>
        </div>
        <span class="hist-chevron" aria-hidden="true">›</span>
      </div>
    `;
  }).join('');
}

function renderWeekNutrition(meals) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(mealDate, -i);
    days.push({ date, ...mealTotals(meals, date) });
  }

  const sums = days.reduce((a, d) => ({
    calories: a.calories + d.calories,
    protein:  a.protein  + d.protein,
    carbs:    a.carbs    + d.carbs,
    fat:      a.fat      + d.fat,
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  document.getElementById('week-nut-totals').innerHTML = [
    [num(sums.calories / 7), `${t('kcal')} ${t('avgPerDay')}`],
    [num(sums.protein / 7) + t('grams'), t('protein')],
    [num(sums.carbs / 7)   + t('grams'), t('carbs')],
    [num(sums.fat / 7)     + t('grams'), t('fat')],
  ].map(([val, lbl]) => `
    <div>
      <span class="stat-val">${sanitize(val)}</span>
      <span class="stat-lbl">${sanitize(lbl)}</span>
    </div>
  `).join('');

  const goal = loadGoal();
  const max  = Math.max(goal, ...days.map(d => d.calories), 1);
  document.getElementById('week-nut-chart').innerHTML = days.map(d => `
    <div class="bar-col${d.date === mealDate ? ' selected' : ''}">
      <span class="bar-val">${d.calories > 0 ? num(d.calories) : ''}</span>
      <div class="bar${goal > 0 && d.calories > goal ? ' over' : ''}"
           style="height:${(d.calories / max) * 100}%"
           title="${sanitize(d.date)}: ${num(d.calories)} ${sanitize(t('kcal'))}"></div>
      <span class="bar-day">${sanitize(weekdayLabel(d.date))}</span>
    </div>
  `).join('');
}

// ─── Mutations ────────────────────────────────────────────────────────────────

function addMeal(meal) {
  const meals = loadMeals();
  meals.push(meal);
  saveMeals(meals);
  afterMealChange();
}

function mealFromForm() {
  const form = document.getElementById('meal-form');
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  if (!name) { form.elements.name.focus(); return null; }
  return {
    id:        createId(),
    createdAt: Date.now(),
    name,
    type:      String(data.get('type') || 'snack'),
    date:      mealDate,
    servings:  Number(data.get('servings')) || 1,
    calories:  Number(data.get('calories')) || 0,
    protein:   Number(data.get('protein'))  || 0,
    carbs:     Number(data.get('carbs'))    || 0,
    fat:       Number(data.get('fat'))      || 0,
  };
}

function submitMealForm() {
  const meal = mealFromForm();
  if (!meal) return;
  addMeal(meal);

  const form = document.getElementById('meal-form');
  const keepType = form.elements.type.value;
  form.reset();
  renderMealForm();
  form.elements.type.value = keepType;
  toast(`🍽️ ${meal.name}`);
}

// Called by the nutrition assistant when the user taps "Add to log".
function addMealFromEstimate(estimate) {
  const meal = {
    id:        createId(),
    createdAt: Date.now(),
    name:      String(estimate.name || '').trim() || t('addMeal'),
    type:      defaultMealType(),
    date:      mealDate,
    servings:  Number(estimate.servings) || 1,
    calories:  Number(estimate.calories) || 0,
    protein:   Number(estimate.protein)  || 0,
    carbs:     Number(estimate.carbs)    || 0,
    fat:       Number(estimate.fat)      || 0,
  };
  addMeal(meal);
  toast(`🍽️ ${meal.name}`);
}

function deleteMeal(id) {
  saveMeals(loadMeals().filter(m => m.id !== id));
  afterMealChange();
}

function afterMealChange() {
  renderMealTotals(loadMeals());
  const meals = loadMeals();
  renderMealList(meals);
  renderWeekNutrition(meals);
  renderTodayNutrition();
}

// ─── Edit modal ───────────────────────────────────────────────────────────────

function openMealEditor(id) {
  if (document.querySelector('.modal-bg')) return;
  const meal = loadMeals().find(m => m.id === id);
  if (!meal) return;

  const { box, close, show } = openModal(t('edit'));

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = meal.name;
  box.appendChild(title);

  const form = document.createElement('form');
  form.className = 'meal-edit-form';
  form.innerHTML = `
    <label>${sanitize(t('foodName'))}
      <input name="name" type="text" required value="${escapeAttr(meal.name)}" />
    </label>
    <div class="field-row">
      <label>${sanitize(t('mealType'))}
        <select name="type">
          ${MEAL_TYPES.map(v =>
            `<option value="${v}"${meal.type === v ? ' selected' : ''}>${sanitize(t(v))}</option>`
          ).join('')}
        </select>
      </label>
      <label>${sanitize(t('date'))}
        <input name="date" type="date" required value="${escapeAttr(meal.date)}" />
      </label>
    </div>
    <div class="field-row">
      <label>${sanitize(t('servings'))}
        <input name="servings" type="number" min="0.25" step="0.25" required value="${escapeAttr(meal.servings)}" />
      </label>
      <label>${sanitize(t('calories'))}
        <input name="calories" type="number" min="0" step="1" required value="${escapeAttr(meal.calories)}" />
      </label>
    </div>
    <div class="field-row">
      <label>${sanitize(t('protein'))}
        <input name="protein" type="number" min="0" step="0.1" required value="${escapeAttr(meal.protein)}" />
      </label>
      <label>${sanitize(t('carbs'))}
        <input name="carbs" type="number" min="0" step="0.1" required value="${escapeAttr(meal.carbs)}" />
      </label>
      <label>${sanitize(t('fat'))}
        <input name="fat" type="number" min="0" step="0.1" required value="${escapeAttr(meal.fat)}" />
      </label>
    </div>
    <div class="modal-actions">
      <button type="submit" class="btn-primary">${sanitize(t('save'))}</button>
      <button type="button" class="btn-danger" data-role="delete">${sanitize(t('del'))}</button>
    </div>
  `;

  form.addEventListener('submit', e => {
    e.preventDefault();
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    if (!name) return;
    const updated = {
      ...meal,
      name,
      type:     String(data.get('type')),
      date:     String(data.get('date')),
      servings: Number(data.get('servings')) || 1,
      calories: Number(data.get('calories')) || 0,
      protein:  Number(data.get('protein'))  || 0,
      carbs:    Number(data.get('carbs'))    || 0,
      fat:      Number(data.get('fat'))      || 0,
    };
    saveMeals(loadMeals().map(m => (m.id === meal.id ? updated : m)));
    // Follow the meal if its date moved, so the edit stays visible.
    mealDate = updated.date;
    close();
    renderMealDateBar();
    afterMealChange();
  });

  form.querySelector('[data-role="delete"]').addEventListener('click', () => {
    deleteMeal(meal.id);
    close();
  });

  box.appendChild(form);
  show();
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

const CSV_HEADERS = ['id', 'createdAt', 'date', 'type', 'name', 'servings',
                     'calories', 'protein', 'carbs', 'fat'];

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function exportMealsCsv() {
  const meals = loadMeals();
  const lines = [CSV_HEADERS.join(',')]
    .concat(meals.map(m => CSV_HEADERS.map(h => csvEscape(m[h])).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `meals-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setText('meal-data-status', `${t('exported')} ${meals.length} ${t('mealsUnit')}`);
}

function parseCsvRow(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === ',') { out.push(cur); cur = ''; }
    else if (c === '"')   { inQuotes = true; }
    else                  { cur += c; }
  }
  out.push(cur);
  return out;
}

function importMealsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return { added: 0, skipped: 0 };

  const header = parseCsvRow(lines[0]).map(h => h.trim().toLowerCase());
  const idx    = h => header.indexOf(h.toLowerCase());
  for (const required of ['date', 'name', 'calories', 'protein', 'carbs', 'fat']) {
    if (idx(required) < 0) throw new Error(`Missing column: ${required}`);
  }

  const meals  = loadMeals();
  const seen   = new Set(meals.map(m => m.id));
  let added = 0, skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const get  = h => (idx(h) >= 0 ? cols[idx(h)] : '');

    const id = get('id');
    if (id && seen.has(id)) { skipped++; continue; }

    const name = String(get('name')).trim();
    const date = String(get('date')).trim();
    if (!name || !DATE_RE.test(date)) { skipped++; continue; }

    const meal = {
      id:        id || createId(),
      createdAt: Number(get('createdAt')) || Date.now() + i,
      date,
      type:      MEAL_TYPES.includes(get('type')) ? get('type') : 'snack',
      name,
      servings:  Number(get('servings')) || 1,
      calories:  Number(get('calories')) || 0,
      protein:   Number(get('protein'))  || 0,
      carbs:     Number(get('carbs'))    || 0,
      fat:       Number(get('fat'))      || 0,
    };
    meals.push(meal);
    seen.add(meal.id);
    added++;
  }

  saveMeals(meals);
  return { added, skipped };
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

Object.assign(ACTIONS, {
  'meal-add':    () => submitMealForm(),
  'meal-edit':   id => openMealEditor(id),
  'meal-export': () => exportMealsCsv(),
});

onInit(() => {
  document.getElementById('meal-form').addEventListener('submit', e => {
    e.preventDefault();
    submitMealForm();
  });

  document.getElementById('meal-date').addEventListener('change', e => {
    mealDate = e.target.value || todayStr();
    renderMealDateBar();
    afterMealChange();
  });

  document.getElementById('meal-goal').addEventListener('change', e => {
    saveGoal(Number(e.target.value) || 0);
    renderMealTotals(loadMeals());
    renderWeekNutrition(loadMeals());
    renderTodayNutrition();
  });

  const importInput = document.getElementById('meal-import');
  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    try {
      const { added, skipped } = importMealsCsv(await file.text());
      setText('meal-data-status',
        `${t('imported')} ${added} ${t('mealsUnit')}${skipped ? ` (+${skipped} ⊘)` : ''}`);
      afterMealChange();
    } catch (err) {
      setText('meal-data-status', `${t('importFailed')}: ${err.message}`);
    } finally {
      importInput.value = '';
    }
  });
});
