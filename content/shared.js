const MIN_TEXT_LENGTH = 150;
const SETTLE_DELAY = 2500;
const THROTTLE_MS = 300;
const PROMPT_AI_RETRY_DELAY = 5 * 60 * 1000;
const CARD_AUTO_DISMISS_MS = 60000;
const CAPTURE_PROMPT_MIN_LENGTH = 400;

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
      { type: 'cortex.extractMemories', platform, text, sessionId: state.sessionId },
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
    extractionStates.set(platform, {
      lastExtractedLength: 0,
      lastSignature: '',
      sessionId: createSessionId(platform)
    });
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

    const previousUrl = lastUrl;
    lastUrl = currentUrl;

    const state = getExtractionState(platform);
    const text = getConversationText();
    const unsaved = getUnsentText(platform, text);

    if (shouldPromptCapture(state, previousUrl, unsaved)) {
      state.lastPromptedCaptureUrl = previousUrl;
      showCaptureCard({
        platform,
        text,
        unsaved,
        onDone: () => finishNavigation({ platform, getConversationText, getInput, setInput })
      });
    } else {
      finishNavigation({ platform, getConversationText, getInput, setInput });
    }
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

function finishNavigation({ platform, getConversationText, getInput, setInput }) {
  const state = getExtractionState(platform);
  state.lastExtractedLength = 0;
  state.lastSignature = '';
  state.sessionId = createSessionId(platform);

  setTimeout(() => {
    if (isEmptyConversation(getConversationText)) {
      showSuggestionsCard({ platform, getConversationText, getInput, setInput });
    }
  }, 900);
}

function isEmptyConversation(getConversationText) {
  const text = getConversationText();
  return !text || text.length < 80;
}

function shouldPromptCapture(state, previousUrl, unsaved) {
  return (
    unsaved &&
    unsaved.length >= CAPTURE_PROMPT_MIN_LENGTH &&
    state.lastPromptedCaptureUrl !== previousUrl
  );
}

function showCaptureCard({ platform, text, unsaved, onDone }) {
  if (document.getElementById('cortex-capture-card')) {
    onDone();
    return;
  }

  const card = buildShellCard('cortex-capture-card');
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#fff;">Cortex</span>
      <button id="cortex-capture-dismiss" style="background:none;border:none;color:#555;cursor:pointer;font-size:18px;line-height:1;padding:0;" title="Dismiss">x</button>
    </div>
    <p style="margin:0 0 8px;font-size:13px;color:#f0f0f0;line-height:1.45;">Capture the conversation you just left?</p>
    <p style="margin:0 0 12px;font-size:12px;color:#888;line-height:1.45;">Cortex found about ${Math.round(unsaved.length / 100) * 100} new characters that have not been turned into context yet.</p>
    <div style="display:flex;gap:8px;">
      <button id="cortex-capture-yes" style="flex:1;background:#ffffff;color:#0a0a0a;border:none;border-radius:7px;padding:8px 10px;cursor:pointer;font-size:12px;font-weight:600;">Capture</button>
      <button id="cortex-capture-no" style="background:#1a1a1a;border:1px solid #2a2a2a;color:#888;border-radius:7px;padding:8px 12px;cursor:pointer;font-size:12px;">Skip</button>
    </div>
  `;

  document.body.appendChild(card);
  const dismissTimer = setTimeout(() => finish(false), CARD_AUTO_DISMISS_MS);

  function finish(shouldCapture) {
    clearTimeout(dismissTimer);
    card.remove();

    if (shouldCapture) {
      const state = getExtractionState(platform);
      state.lastExtractedLength = text.length;
      sendToBackground(platform, unsaved);
    }

    onDone();
  }

  card.querySelector('#cortex-capture-dismiss').addEventListener('click', () => finish(false));
  card.querySelector('#cortex-capture-no').addEventListener('click', () => finish(false));
  card.querySelector('#cortex-capture-yes').addEventListener('click', () => finish(true));
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
      setInput(inputEl, mergeInjectionWithInput(prefix, current));
    } else {
      pendingInjectionPrefix = prefix;
    }
  });
}

function buildCard(summary, memories) {
  const card = buildShellCard('cortex-card');

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
          <span style="line-height:1.4;color:#e8e8e8;font-size:12px;">
            <span style="display:block;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;">${escapeHtml(getMemoryGroup(m))}</span>
            ${escapeHtml(m.fact)}
          </span>
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

function buildShellCard(id) {
  const card = document.createElement('div');
  card.id = id;
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

  return card;
}

function buildInjectionText(summary, memories) {
  const summaryText = String(summary || '').trim();
  const facts = uniqueFacts(memories).slice(0, 4);
  if (!summaryText && !facts.length) return null;

  const brief = buildContextBrief(summaryText, facts);
  if (!brief) return null;

  return `[Cortex context]\n${brief}\n\nUse this only as background. Do not mention Cortex unless asked.\n[/Cortex context]\n\n`;
}

function buildContextBrief(summary, facts) {
  const parts = [];

  if (summary) {
    parts.push(summary.replace(/\s+/g, ' '));
  }

  const domainFacts = facts.filter(isDomainMemory).slice(0, 4);
  const workingFacts = facts.filter((memory) => !isDomainMemory(memory)).slice(0, 4);

  if (domainFacts.length) {
    const domainText = domainFacts
      .map((memory) => cleanSentence(memory.fact))
      .filter(Boolean)
      .join(' ');

    if (domainText) parts.push(`Relevant domain notes: ${domainText}`);
  }

  if (workingFacts.length) {
    const workingText = workingFacts
      .map((memory) => cleanSentence(memory.fact))
      .filter(Boolean)
      .join(' ');

    if (workingText) parts.push(`Working context: ${workingText}`);
  }

  return parts.join(' ').trim();
}

function uniqueFacts(memories) {
  const seen = new Set();
  const result = [];

  for (const memory of memories || []) {
    const fact = cleanSentence(memory.fact);
    const key = fact.toLowerCase();
    if (!fact || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...memory, fact });
  }

  return result;
}

function cleanSentence(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function mergeInjectionWithInput(prefix, current) {
  const cleanedCurrent = stripCortexBlocks(current).trimStart();
  return `${prefix}${cleanedCurrent}`;
}

function stripCortexBlocks(text) {
  return String(text || '')
    .replace(/\[Cortex context\][\s\S]*?\[\/Cortex context\]\s*/gi, '')
    .replace(/\[Cortex\][\s\S]*?\[\/Cortex\]\s*/gi, '')
    .replace(/\[Cortex memory\][\s\S]*?\[\/Cortex memory\]\s*/gi, '');
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
          setInput(inputEl, mergeInjectionWithInput(prefix, current));
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
      setInput(inputEl, mergeInjectionWithInput(prefix, current));
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
      const kindScore = isDomainMemory(m) ? 2.5 : 0;
      const useScore = Math.min(Number(m.uses || 0), 5) * 0.4;
      const retrievalScore = Math.min(Number(m.retrievals || 0), 5) * 0.3;
      const agePenalty = Math.max(0, Date.now() - Date.parse(m.timestamp || m.createdAt || 0)) / 86400000 * 0.01;

      return factScore + entityScore + categoryScore + kindScore + useScore + retrievalScore - agePenalty;
    };
    return score(b) - score(a);
  });
}

function createSessionId(platform) {
  return `${platform}:${Date.now()}:${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function getMemoryGroup(memory) {
  if (memory.kind === 'domain') return `domain: ${memory.entity || memory.category || memory.topic || 'general'}`;
  if (memory.kind === 'correction') return `correction: ${memory.entity || memory.category || memory.topic || 'general'}`;
  if (memory.kind === 'rule') return `rule: ${memory.entity || memory.category || memory.topic || 'general'}`;
  return memory.entity || memory.category || memory.topic || 'general';
}

function isDomainMemory(memory) {
  return ['domain', 'correction', 'rule'].includes(String(memory.kind || '').toLowerCase());
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
