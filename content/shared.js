const MIN_TEXT_LENGTH = 150;
const SETTLE_DELAY = 2500;
const THROTTLE_MS = 300;
const PROMPT_AI_RETRY_DELAY = 5 * 60 * 1000;
const CARD_AUTO_DISMISS_MS = 60000;

let extractionPausedUntil = 0;
let pendingInjectionPrefix = null;
const extractionStates = new Map();

// ---------------------------------------------------------------------------
// RESPONSE WATCHER
// ---------------------------------------------------------------------------
export function startWatching({ platform, getConversationText }) {
  let lastLength = 0;
  const state = getExtractionState(platform);
  let debounceTimer = null;
  let lastCheckTime = 0;

  function check() {
    const now = Date.now();
    if (now - lastCheckTime < THROTTLE_MS) return;
    lastCheckTime = now;

    const text = getConversationText();
    const len = text?.length || 0;

    if (len > lastLength + 20) {
      lastLength = len;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const currentText = getConversationText();
        if (!currentText || currentText.length < MIN_TEXT_LENGTH) return;

        const newText = getUnsentText(platform, currentText);
        if (newText.length < MIN_TEXT_LENGTH) return;

        state.lastExtractedLength = currentText.length;
        sendToBackground(platform, newText);
      }, SETTLE_DELAY);
    }
  }

  window.addEventListener('pagehide', () => {
    const text = getConversationText();
    const unsaved = getUnsentText(platform, text);
    if (unsaved && unsaved.length >= MIN_TEXT_LENGTH) {
      state.lastExtractedLength = text.length;
      sendToBackground(platform, unsaved);
    }
  });

  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(check, 1000);
}

function sendToBackground(platform, text) {
  if (Date.now() < extractionPausedUntil) return;
  if (!chrome?.runtime?.sendMessage) return;

  const signature = `${platform}:${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
  const state = getExtractionState(platform);
  if (state.lastSignature === signature) return;
  state.lastSignature = signature;

  try {
    chrome.runtime.sendMessage(
      { type: 'cortex.extractMemories', platform, text },
      (response) => {
        if (chrome.runtime?.lastError) return;
        if (response?.saved > 0) {
          console.log(`Cortex: +${response.saved} memor${response.saved === 1 ? 'y' : 'ies'} from ${platform}`);
        } else if (response?.error) {
          if (isPromptAiReadinessError(response.error)) {
            extractionPausedUntil = Date.now() + PROMPT_AI_RETRY_DELAY;
          }
          console.warn('Cortex:', response.error);
        }
      }
    );
  } catch {
    // Context invalidated
  }
}

function isPromptAiReadinessError(error) {
  return /Prompt AI|model is not ready|model not downloaded|unavailable/i.test(error);
}

function getExtractionState(platform) {
  if (!extractionStates.has(platform)) {
    extractionStates.set(platform, { lastExtractedLength: 0, lastSignature: '' });
  }
  return extractionStates.get(platform);
}

function getUnsentText(platform, fullText = '') {
  if (!fullText) return '';
  const state = getExtractionState(platform);
  return fullText.slice(state.lastExtractedLength).trim();
}

// ---------------------------------------------------------------------------
// NAVIGATION WATCHER
// Intercepts SPA pushState/popstate to detect new chats on the same tab.
// Forces extraction on navigate-away and shows the suggestions card.
// ---------------------------------------------------------------------------
export function startNavigationWatcher({ platform, getConversationText, getInput, getSubmit, setInput }) {
  let lastUrl = location.href;

  function onUrlChange() {
    const currentUrl = location.href;
    if (currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    // Force-extract only unsaved conversation content.
    const text = getConversationText();
    const unsaved = getUnsentText(platform, text);
    if (unsaved && unsaved.length >= MIN_TEXT_LENGTH) {
      getExtractionState(platform).lastExtractedLength = text.length;
      sendToBackground(platform, unsaved);
    }

    // Show card if new destination is a fresh/empty chat
    setTimeout(() => {
      if (isEmptyConversation(getConversationText)) {
        showSuggestionsCard({ platform, getConversationText, getInput, setInput });
      }
    }, 900);
  }

  const origPush = history.pushState.bind(history);
  history.pushState = (...args) => { origPush(...args); onUrlChange(); };

  const origReplace = history.replaceState.bind(history);
  history.replaceState = (...args) => { origReplace(...args); onUrlChange(); };

  window.addEventListener('popstate', onUrlChange);

  // Show card on initial page load if this is already a fresh chat
  setTimeout(() => {
    if (isEmptyConversation(getConversationText)) {
      showSuggestionsCard({ platform, getConversationText, getInput, setInput });
    }
  }, 1500);
}

function isEmptyConversation(getConversationText) {
  const text = getConversationText();
  return !text || text.length < 80;
}

// ---------------------------------------------------------------------------
// SUGGESTIONS CARD
// Floating card on new/empty chats. "Inject selected" immediately writes
// the chosen memories into the input box so the user sees them before sending.
// ---------------------------------------------------------------------------
async function showSuggestionsCard({ platform, getConversationText, getInput, setInput }) {
  // Don't replace a card that's already open
  if (document.getElementById('cortex-card')) return;

  // Re-check because conversation content sometimes loads after the URL change.
  if (!isEmptyConversation(getConversationText)) return;

  const storageKeys = ['memories', `cortex.lastSummary.${platform}`];
  const stored = await chrome.storage.local.get(storageKeys);
  const memories = stored.memories || [];
  const lastSummary = stored[`cortex.lastSummary.${platform}`] || '';

  if (!memories.length && !lastSummary) return;

    const context = document.title + ' ' + location.pathname;
  const top = findRelevant(memories, context).slice(0, 5);

  const card = buildCard(lastSummary, top);
  document.body.appendChild(card);

  const dismissTimer = setTimeout(() => card.remove(), CARD_AUTO_DISMISS_MS);

  function dismiss() {
    clearTimeout(dismissTimer);
    card.remove();
  }

  card.querySelector('#cortex-card-dismiss').addEventListener('click', dismiss);
  card.querySelector('#cortex-card-skip').addEventListener('click', dismiss);

  card.querySelectorAll('.cortex-chip').forEach(label => {
    const cb = label.querySelector('input');
    cb.addEventListener('change', () => {
      label.style.background = cb.checked ? '#2a2a2a' : '#1a1a1a';
      label.style.borderColor = cb.checked ? '#555' : '#2a2a2a';
    });
  });

  card.querySelector('#cortex-card-apply').addEventListener('click', () => {
    const selectedMemories = [...card.querySelectorAll('input[type="checkbox"]:checked')]
      .map(cb => top[parseInt(cb.dataset.index)])
      .filter(Boolean);

    dismiss();
    markMemoriesRetrieved(selectedMemories);

    const prefix = buildInjectionText(lastSummary, selectedMemories);
    if (!prefix) return;

    const inputEl = getInput();
    if (inputEl) {
      const current = getText(inputEl);
      setInput(inputEl, prefix + current);
    } else {
      pendingInjectionPrefix = prefix;
    }
  });
}

function buildCard(summary, memories) {
  const card = document.createElement('div');
  card.id = 'cortex-card';
  card.style.cssText = [
    'position:fixed',
    'bottom:88px',
    'right:20px',
    'z-index:2147483647',
    'width:308px',
    'background:#0a0a0a',
    'border:1px solid #2a2a2a',
    'border-radius:10px',
    'padding:14px 16px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-size:13px',
    'color:#f0f0f0',
    'box-sizing:border-box',
  ].join(';');

  const summaryHtml = summary ? `
    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:7px;padding:10px;margin-bottom:10px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#888;margin-bottom:5px;">Last session</div>
      <p style="margin:0;font-size:12px;color:#e8e8e8;line-height:1.5;">${escapeHtml(summary)}</p>
    </div>
  ` : '';

  const memoriesHtml = memories.length ? `
    <p style="margin:0 0 6px;font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.05em;">Also include</p>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
      ${memories.map((m, i) => `
        <label class="cortex-chip" style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-radius:6px;border:1px solid #2a2a2a;background:#1a1a1a;transition:all 0.15s;">
          <input type="checkbox" data-index="${i}" style="margin-top:2px;flex-shrink:0;cursor:pointer;accent-color:#ffffff;" />
          <span style="line-height:1.4;color:#e8e8e8;font-size:12px;">${escapeHtml(m.fact)}</span>
        </label>
      `).join('')}
    </div>
  ` : '<div style="margin-bottom:12px;"></div>';

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#fff;">Cortex</span>
      <button id="cortex-card-dismiss" style="background:none;border:none;color:#555;cursor:pointer;font-size:18px;line-height:1;padding:0;" title="Dismiss">x</button>
    </div>
    ${summaryHtml}
    ${memoriesHtml}
    <div style="display:flex;gap:8px;">
      <button id="cortex-card-apply" style="flex:1;background:#ffffff;color:#0a0a0a;border:none;border-radius:7px;padding:8px 10px;cursor:pointer;font-size:12px;font-weight:600;">${summary ? 'Continue session' : 'Inject selected'}</button>
      <button id="cortex-card-skip" style="background:#1a1a1a;border:1px solid #2a2a2a;color:#888;border-radius:7px;padding:8px 12px;cursor:pointer;font-size:12px;">Skip</button>
    </div>
  `;

  return card;
}

function buildInjectionText(summary, memories) {
  if (!summary && !memories.length) return null;

  let text = '[Cortex]\n';

  if (summary) {
    text += `Continuing from your last session: ${summary}\n`;
  }

  if (memories.length) {
    text += '\nBackground:\n';
    text += memories.map(m => `- ${m.fact}`).join('\n') + '\n';
  }

  text += '[/Cortex]\n\n';
  return text;
}

// ---------------------------------------------------------------------------
// INJECTOR
// For popup-triggered manual injection (queues prefix for next submit).
// The card uses direct injection instead.
// ---------------------------------------------------------------------------
export function setupInjector({ getInput, getSubmit, setInput }) {
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'cortex.queueInjection' && message.memories?.length) {
        const prefix = buildInjectionText('', message.memories);
        if (!prefix) return;

        const inputEl = getInput();
        if (inputEl) {
          const current = getText(inputEl);
          setInput(inputEl, prefix + current);
        } else {
          pendingInjectionPrefix = prefix;
        }
      }
    });
  }

  // Fallback: inject pending prefix on next submit if immediate injection failed
  document.addEventListener(
    'click',
    (e) => {
      if (!pendingInjectionPrefix) return;

      const submitEl = getSubmit();
      if (!submitEl) return;

      const clicked = e.target.closest?.('button') || e.target;
      if (clicked !== submitEl && !submitEl.contains(e.target)) return;

      const inputEl = getInput();
      if (!inputEl) return;
      const current = getText(inputEl);
      if (!current.trim()) return;

      const prefix = pendingInjectionPrefix;
      pendingInjectionPrefix = null;

      e.stopImmediatePropagation();
      e.preventDefault();
      setInput(inputEl, prefix + current);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const fresh = getSubmit();
        if (fresh) fresh.click();
      }));
    },
    { capture: true }
  );
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function findRelevant(memories, context) {
  const lower = context.toLowerCase();
  return [...memories].sort((a, b) => {
    const score = (m) => {
      const factScore = String(m.fact || '').toLowerCase().split(/\s+/)
        .filter((w) => w.length > 3 && lower.includes(w))
        .length;
      const entityScore = m.entity && lower.includes(String(m.entity).toLowerCase()) ? 4 : 0;
      const categoryScore = m.category && lower.includes(String(m.category).toLowerCase()) ? 2 : 0;
      const useScore = Math.min(Number(m.uses || 0), 5) * 0.4;
      const retrievalScore = Math.min(Number(m.retrievals || 0), 5) * 0.3;
      const agePenalty = Math.max(0, Date.now() - Date.parse(m.timestamp || m.createdAt || 0)) / 86400000 * 0.01;

      return factScore + entityScore + categoryScore + useScore + retrievalScore - agePenalty;
    };
    return score(b) - score(a);
  });
}

async function markMemoriesRetrieved(selectedMemories) {
  if (!selectedMemories.length) return;

  const selectedIds = new Set(selectedMemories.map((memory) => memory.id).filter(Boolean));
  if (!selectedIds.size) return;

  const stored = await chrome.storage.local.get(['memories']);
  const now = new Date().toISOString();
  const memories = (stored.memories || []).map((memory) => {
    if (!selectedIds.has(memory.id)) return memory;
    return {
      ...memory,
      lastRetrieved: now,
      retrievals: Number(memory.retrievals || 0) + 1
    };
  });

  await chrome.storage.local.set({ memories });
}

function getText(el) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
  return el.innerText || el.textContent || '';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function setContentEditable(el, text) {
  el.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
}

export function setReactTextarea(el, text) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  ).set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function waitForElement(getEl, timeout = 8000) {
  return new Promise((resolve) => {
    const el = getEl();
    if (el) return resolve(el);
    const start = Date.now();
    const id = setInterval(() => {
      const el = getEl();
      if (el) { clearInterval(id); resolve(el); }
      else if (Date.now() - start > timeout) { clearInterval(id); resolve(null); }
    }, 400);
  });
}

export function collectText(...selectors) {
  const parts = [];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => {
      const t = el.innerText?.trim();
      if (t) parts.push(t);
    });
  }
  return parts.join('\n\n');
}

export function querySelector(...selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}
