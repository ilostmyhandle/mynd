import Summarizer from './memory/summarizer.js';
import StorageManager from './memory/storage.js';
import SettingsManager from './memory/settings.js';

const OAUTH_CALLBACK_PATH = 'auth';
const OAUTH_RESPONSE_KEY = 'mynd.pendingOAuthResponseUrl';
const LEGACY_OAUTH_RESPONSE_KEY = 'cortex.pendingOAuthResponseUrl';

// ---------------------------------------------------------------------------
// MEMORY EXTRACTION
// Content scripts send conversation text here. Chrome AI is routed through
// an offscreen document (the only renderer context available to service
// workers). All other providers use fetch directly.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;

  if (message?.type === 'mynd.extractMemories') {
    handleExtraction(message.platform, message.text, message.sessionId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: safeErrorMessage(err) }));
    return true;
  }

  if (message?.type === 'mynd.promptAiStatus') {
    getPromptAiStatus()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: safeErrorMessage(err) }));
    return true;
  }
});

function isTrustedSender(sender) {
  return sender?.id === chrome.runtime.id;
}

async function handleExtraction(platform, text, sessionId = '') {
  const settings = await SettingsManager.getSettings();
  let result;

  if (settings.provider === 'chrome-ai') {
    result = await extractViaOffscreen(text);
  } else {
    result = await Summarizer.extractMemories(text);
  }

  const { summary, memories } = result;

  if (summary) {
    await chrome.storage.local.set({ [`mynd.lastSummary.${platform}`]: summary });
    await chrome.storage.local.remove([`cortex.lastSummary.${platform}`]);
  }

  let saved = 0;
  for (const m of memories) {
    const r = await StorageManager.saveMemory(m.fact, platform, m.topic, {
      entity: m.entity,
      category: m.category,
      kind: m.kind,
      sessionId: m.sessionId || sessionId,
      action: m.action,
      target: m.target
    });
    if (r.success) saved++;
  }
  return { success: true, extracted: memories.length, saved };
}

// ---------------------------------------------------------------------------
// OFFSCREEN - used only for Chrome built-in AI (needs renderer context)
// ---------------------------------------------------------------------------
async function extractViaOffscreen(text) {
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'mynd.offscreen.extract', text },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response?.success) resolve({ summary: response.summary || '', memories: response.memories || [] });
        else reject(new Error(response?.error || 'Offscreen extraction failed.'));
      }
    );
  });
}

async function getPromptAiStatus() {
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'mynd.offscreen.status' },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }

        resolve(response);
      }
    );
  });
}

async function ensureOffscreen() {
  try {
    const existing = await chrome.offscreen.hasDocument();
    if (!existing) await createOffscreen();
  } catch {
    await createOffscreen();
  }
}

function createOffscreen() {
  return chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_SCRAPING'],
    justification: 'Access window.ai for Chrome built-in AI memory extraction'
  });
}

// ---------------------------------------------------------------------------
// OAUTH
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (!isOAuthCallbackUrl(changeInfo.url)) return;

  await chrome.storage.local.set({ [OAUTH_RESPONSE_KEY]: changeInfo.url });
  await chrome.storage.local.remove([LEGACY_OAUTH_RESPONSE_KEY]);

  chrome.runtime.sendMessage({
    type: 'mynd.oauthCallback',
    url: changeInfo.url
  }).catch(() => {});

  chrome.tabs.remove(tabId).catch(() => {});
});

function isOAuthCallbackUrl(url) {
  const extensionRedirectUrl = chrome.identity.getRedirectURL(OAUTH_CALLBACK_PATH);
  if (url.startsWith(extensionRedirectUrl)) return true;
  return false;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error.');
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}

console.log('mynd background service running.');
