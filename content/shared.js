const MIN_TEXT_LENGTH = 150;
const SETTLE_DELAY = 2500;
const THROTTLE_MS = 300;
const PROMPT_AI_RETRY_DELAY = 5 * 60 * 1000;

let extractionPausedUntil = 0;

// ---------------------------------------------------------------------------
// RESPONSE WATCHER
// MutationObserver watches for AI response text growing. When it stops
// growing for SETTLE_DELAY ms, we send only the newly settled text to the
// background script for extraction. The background script has access to Chrome
// AI and external APIs; content scripts on third-party pages do not.
// ---------------------------------------------------------------------------
export function startWatching({ platform, getConversationText }) {
  let lastLength = 0;
  let lastExtractedLength = 0;
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
        if (currentText.length <= lastExtractedLength + 100) return;

        const newText = currentText.slice(lastExtractedLength).trim();
        if (newText.length < MIN_TEXT_LENGTH) return;

        lastExtractedLength = currentText.length;
        sendToBackground(platform, newText);
      }, SETTLE_DELAY);
    }
  }

  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(check, 1000);
}

function sendToBackground(platform, text) {
  if (Date.now() < extractionPausedUntil) return;

  // chrome.runtime can become undefined if the service worker went to sleep
  // and the extension context was invalidated; guard before every call.
  if (!chrome?.runtime?.sendMessage) return;

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
    // Context invalidated between the guard check and the call; ignore.
  }
}

function isPromptAiReadinessError(error) {
  return /Prompt AI|model is not ready|model not downloaded|unavailable/i.test(error);
}

// ---------------------------------------------------------------------------
// INJECTOR
// Prepends top memories to the user's first message of the session.
// sessionStorage resets on tab close so injection happens once per session.
// ---------------------------------------------------------------------------
export async function setupInjector({ getInput, getSubmit, setInput }) {
  if (sessionStorage.getItem('cortex.injected')) return;

  const stored = await chrome.storage.local.get(['memories']);
  const memories = stored.memories || [];
  if (!memories.length) return;

  const relevant = findRelevant(memories, document.title + ' ' + location.pathname);
  const top = relevant.slice(0, 6);
  if (!top.length) return;

  const prefix =
    '[Cortex memory]\n' +
    top.map((m) => `- ${m.fact}`).join('\n') +
    '\n[/Cortex memory]\n\n';

  const submitEl = await waitForElement(getSubmit, 12000);
  if (!submitEl) return;

  submitEl.addEventListener(
    'click',
    (e) => {
      const inputEl = getInput();
      if (!inputEl) return;
      const current = getText(inputEl);
      if (!current.trim()) return;

      e.stopImmediatePropagation();
      e.preventDefault();
      sessionStorage.setItem('cortex.injected', '1');
      setInput(inputEl, prefix + current);
      requestAnimationFrame(() => requestAnimationFrame(() => submitEl.click()));
    },
    { capture: true, once: true }
  );
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function findRelevant(memories, context) {
  const lower = context.toLowerCase();
  return [...memories].sort((a, b) => {
    const score = (m) =>
      m.fact.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && lower.includes(w)).length;
    return score(b) - score(a);
  });
}

function getText(el) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
  return el.innerText || el.textContent || '';
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
      if (el) {
        clearInterval(id);
        resolve(el);
      } else if (Date.now() - start > timeout) {
        clearInterval(id);
        resolve(null);
      }
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
