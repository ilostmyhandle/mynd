import Summarizer from './memory/summarizer.js';
import StorageManager from './memory/storage.js';
import SettingsManager from './memory/settings.js';

const OAUTH_CALLBACK_PATH = 'auth';
const OAUTH_RESPONSE_KEY = 'cortex.pendingOAuthResponseUrl';
const DEV_OAUTH_CALLBACK_ORIGIN = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// MEMORY EXTRACTION
// Content scripts send conversation text here. Chrome AI is routed through
// an offscreen document (the only renderer context available to service
// workers). All other providers use fetch directly.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'cortex.extractMemories') {
    handleExtraction(message.platform, message.text)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === 'cortex.promptAiStatus') {
    getPromptAiStatus()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleExtraction(platform, text) {
  const settings = await SettingsManager.getSettings();
  let result;

  if (settings.provider === 'chrome-ai') {
    result = await extractViaOffscreen(text);
  } else {
    result = await Summarizer.extractMemories(text);
  }

  const { summary, memories } = result;

  if (summary) {
    await chrome.storage.local.set({ [`cortex.lastSummary.${platform}`]: summary });
  }

  let saved = 0;
  for (const m of memories) {
    const r = await StorageManager.saveMemory(m.fact, platform, m.topic);
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
      { type: 'cortex.offscreen.extract', text },
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
      { type: 'cortex.offscreen.status' },
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

  chrome.runtime.sendMessage({
    type: 'cortex.oauthCallback',
    url: changeInfo.url
  }).catch(() => {});

  chrome.tabs.remove(tabId).catch(() => {});
});

function isOAuthCallbackUrl(url) {
  const extensionRedirectUrl = chrome.identity.getRedirectURL(OAUTH_CALLBACK_PATH);
  if (url.startsWith(extensionRedirectUrl)) return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === DEV_OAUTH_CALLBACK_ORIGIN &&
      (parsed.searchParams.has('code') ||
        parsed.searchParams.has('error') ||
        parsed.hash.includes('access_token') ||
        parsed.hash.includes('error'))
    );
  } catch {
    return false;
  }
}

console.log('Cortex background service running.');
