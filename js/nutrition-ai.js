'use strict';

// ─── Nutrition assistant ──────────────────────────────────────────────────────
//
// Ported from the standalone Meal Tracker. Calls the Claude API directly from
// the browser, which means the user's own API key lives in localStorage and
// travels from their device to Anthropic — fine for a personal app, not safe to
// hand to other people without a server in front of it.

const AI_KEY_STORAGE  = 'mealtracker.apikey.v1';
const AI_CHAT_STORAGE = 'mealtracker.chat.v1';
const AI_MODEL        = 'claude-haiku-4-5';
const AI_MAX_HISTORY  = 20;

const AI_SYSTEM_PROMPT = `You are a nutrition estimation assistant inside a personal fitness tracker. The user logs meals to track their daily nutrition.

Your job: when the user describes food, estimate calories (kcal), protein (g), carbohydrates (g), and fat (g) for the portion they described. Be specific and practical — favour concrete typical portions over vague answers.

Sources of truth: widely-accepted nutrition data for common foods (USDA FoodData Central averages), restaurant-chain published nutrition facts where applicable, and reasonable assumptions for home-cooked dishes.

Guidance:
- Default to typical/medium portions if size isn't specified, and note the assumption.
- For named restaurant items ("Big Mac", "Starbucks grande latte"), use the chain's official nutrition facts.
- For ambiguous foods ("salad", "pasta"), ask one short clarifying question rather than guessing wildly.
- For non-food questions or chitchat, respond conversationally and set the estimate to null.
- Reply in the same language the user writes in.

Always respond with valid JSON matching the schema:
- "reply" (string, required): A friendly 1-2 sentence message. Explain the estimate briefly, ask for clarification, or chat. Do NOT restate the macros — the UI shows them next to your message.
- "estimate" (object or null, required): The nutrition object if you have a confident estimate; null otherwise.

The estimate object:
- name: Concise food name including the portion (e.g., "Caesar salad with grilled chicken (medium, ~3 cups)")
- servings: Always 1. Your nutrition values represent the entire portion described.
- calories, protein, carbs, fat: Whole numbers for the described portion.
- notes: One sentence noting assumptions (cooking method, portion basis, brand if relevant).

Examples:

User: "medium Caesar salad with grilled chicken"
{
  "reply": "Here's a typical estimate for a medium Caesar with grilled chicken.",
  "estimate": {
    "name": "Caesar salad with grilled chicken (medium)",
    "servings": 1,
    "calories": 470,
    "protein": 35,
    "carbs": 12,
    "fat": 31,
    "notes": "Assumes ~3 cups romaine, 4oz grilled chicken, 2 tbsp Caesar dressing, parmesan, and croutons."
  }
}

User: "I had pizza"
{
  "reply": "What style and how many slices? A typical slice of regular cheese pizza is around 280 kcal; deep dish or pepperoni runs higher.",
  "estimate": null
}`;

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'estimate'],
  properties: {
    reply: {
      type: 'string',
      description: 'Friendly conversational reply, 1-2 sentences. Do not repeat the macros from the estimate.',
    },
    estimate: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'servings', 'calories', 'protein', 'carbs', 'fat', 'notes'],
          properties: {
            name:     { type: 'string', description: 'Concise food name including portion descriptor.' },
            servings: { type: 'number', description: 'Always 1 — represents the entire described portion.' },
            calories: { type: 'number', description: 'Total kilocalories for the described portion.' },
            protein:  { type: 'number', description: 'Grams of protein.' },
            carbs:    { type: 'number', description: 'Grams of carbohydrates.' },
            fat:      { type: 'number', description: 'Grams of fat.' },
            notes:    { type: 'string', description: 'One sentence noting assumptions / caveats.' },
          },
        },
        { type: 'null' },
      ],
    },
  },
};

let aiMessages = loadChat();
let aiSending  = false;

function loadChat() {
  try {
    const parsed = JSON.parse(lsGet(AI_CHAT_STORAGE) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChat() {
  lsSet(AI_CHAT_STORAGE, JSON.stringify(aiMessages.slice(-AI_MAX_HISTORY)));
}

function loadApiKey()      { return lsGet(AI_KEY_STORAGE) || ''; }
function saveApiKey(key)   { if (key) lsSet(AI_KEY_STORAGE, key); else lsRemove(AI_KEY_STORAGE); }

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderAiConfig() {
  const el = document.getElementById('ai-config');
  if (!el) return;
  const key = loadApiKey();

  if (!key) {
    el.innerHTML = `
      <p class="muted">${sanitize(t('apiKeyIntro'))}</p>
      <div class="ai-key-row">
        <input type="password" id="ai-key-input" placeholder="sk-ant-..." autocomplete="off" />
        <button type="button" class="btn-primary" data-action="ai-save-key">${sanitize(t('saveKey'))}</button>
      </div>
      <p class="muted small">${sanitize(t('apiKeyHint'))}</p>
    `;
  } else {
    const masked = key.length > 14 ? `${key.slice(0, 8)}…${key.slice(-4)}` : `…${key.slice(-4)}`;
    el.innerHTML = `
      <div class="ai-key-row inline">
        <span class="muted small">${sanitize(t('apiKeyLabel'))}: <code>${sanitize(masked)}</code></span>
        <button type="button" class="btn-link" data-action="ai-clear-key">${sanitize(t('changeKey'))}</button>
      </div>
    `;
  }
  updateAiFormState();
}

function updateAiFormState() {
  const hasKey = !!loadApiKey();
  const input  = document.getElementById('ai-input');
  const send   = document.getElementById('ai-send');
  if (input) {
    input.disabled = !hasKey || aiSending;
    input.placeholder = t('chatPlaceholder');
  }
  if (send) {
    send.disabled = !hasKey || aiSending;
    send.textContent = t('send');
  }
  setText('ai-clear-label', t('clearChat'));
}

function renderAiChat() {
  const el = document.getElementById('ai-chat');
  if (!el) return;

  el.innerHTML = aiMessages.map(msg => {
    if (msg.role === 'user') {
      return `<div class="chat-msg chat-user">${sanitize(msg.content)}</div>`;
    }
    const parsed = msg.parsed || { reply: msg.content, estimate: null };
    return `
      <div class="chat-msg chat-assistant${msg.isError ? ' chat-error' : ''}">
        <div class="chat-reply">${sanitize(parsed.reply || msg.content)}</div>
        ${parsed.estimate ? estimateCardHtml(parsed.estimate, msg.id) : ''}
      </div>
    `;
  }).join('');

  el.scrollTop = el.scrollHeight;
}

function estimateCardHtml(est, msgId) {
  return `
    <div class="est-card">
      <div class="est-name">${sanitize(est.name)}</div>
      <div class="est-macros">
        <span><strong>${Math.round(Number(est.calories) || 0)}</strong> ${sanitize(t('kcal'))}</span>
        <span><strong>${Math.round(Number(est.protein) || 0)}${sanitize(t('grams'))}</strong> ${sanitize(t('protein'))}</span>
        <span><strong>${Math.round(Number(est.carbs) || 0)}${sanitize(t('grams'))}</strong> ${sanitize(t('carbs'))}</span>
        <span><strong>${Math.round(Number(est.fat) || 0)}${sanitize(t('grams'))}</strong> ${sanitize(t('fat'))}</span>
      </div>
      ${est.notes ? `<div class="est-notes muted small">${sanitize(est.notes)}</div>` : ''}
      <button type="button" class="btn-secondary est-add" data-action="ai-log" data-arg="${sanitize(msgId)}">
        ${sanitize(t('addToLog'))}
      </button>
    </div>
  `;
}

// ─── Sending ──────────────────────────────────────────────────────────────────

async function sendAiMessage(text) {
  if (aiSending) return;
  const apiKey = loadApiKey();
  if (!apiKey) { renderAiConfig(); return; }

  aiSending = true;
  updateAiFormState();

  aiMessages.push({ id: createId(), role: 'user', content: text });
  renderAiChat();

  const chat = document.getElementById('ai-chat');
  const pending = document.createElement('div');
  pending.className = 'chat-msg chat-assistant chat-pending';
  pending.textContent = t('thinking');
  chat.appendChild(pending);
  chat.scrollTop = chat.scrollHeight;

  try {
    const payloadMessages = aiMessages.map(m => ({
      role: m.role,
      content: m.role === 'user'
        ? m.content
        : (m.parsed ? JSON.stringify(m.parsed) : m.content),
    }));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 800,
        system: [{ type: 'text', text: AI_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: payloadMessages,
        // No output_config.effort: Haiku 4.5 rejects it with a 400. It is only
        // supported on Opus 4.5+ and Sonnet 4.6.
        output_config: { format: { type: 'json_schema', schema: AI_SCHEMA } },
      }),
    });

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        message = (body.error && body.error.message) || message;
      } catch { /* non-JSON error body */ }
      throw new Error(message);
    }

    const data = await res.json();
    if (data.stop_reason === 'refusal') {
      throw new Error((data.stop_details && data.stop_details.explanation) || 'Declined.');
    }
    const block = (data.content || []).find(b => b.type === 'text');
    if (!block || !block.text) throw new Error('Empty response.');

    let parsed;
    try { parsed = JSON.parse(block.text); }
    catch { parsed = { reply: block.text, estimate: null }; }

    aiMessages.push({ id: createId(), role: 'assistant', content: block.text, parsed });
    saveChat();
  } catch (err) {
    aiMessages.push({
      id: createId(),
      role: 'assistant',
      isError: true,
      content: `⚠︎ ${err.message}`,
      parsed: { reply: `⚠︎ ${err.message}`, estimate: null },
    });
  } finally {
    pending.remove();
    aiSending = false;
    renderAiChat();
    updateAiFormState();
  }
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

Object.assign(ACTIONS, {
  'ai-save-key': () => {
    const input = document.getElementById('ai-key-input');
    const value = input && input.value.trim();
    if (!value) return;
    saveApiKey(value);
    renderAiConfig();
    document.getElementById('ai-input').focus();
  },
  'ai-clear-key': () => {
    saveApiKey('');
    renderAiConfig();
  },
  'ai-clear-chat': () => {
    if (!aiMessages.length) return;
    aiMessages = [];
    saveChat();
    renderAiChat();
  },
  'ai-log': msgId => {
    const msg = aiMessages.find(m => m.id === msgId);
    if (!msg || !msg.parsed || !msg.parsed.estimate) return;
    addMealFromEstimate(msg.parsed.estimate);
    const btn = document.querySelector(`[data-action="ai-log"][data-arg="${msgId}"]`);
    if (btn) {
      btn.textContent = t('added');
      btn.disabled = true;
    }
  },
});

onInit(() => {
  document.getElementById('ai-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('ai-input');
    const text  = input.value.trim();
    if (!text) return;
    input.value = '';
    sendAiMessage(text);
  });

  renderAiConfig();
  renderAiChat();
});
