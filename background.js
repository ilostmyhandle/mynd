// background.js
// Coordinates between extension pages, content scripts, and storage.

const OAUTH_CALLBACK_PATH = 'auth';
const OAUTH_RESPONSE_KEY = 'cortex.pendingOAuthResponseUrl';

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;

  const redirectUrl = chrome.identity.getRedirectURL(OAUTH_CALLBACK_PATH);

  if (!changeInfo.url.startsWith(redirectUrl)) return;

  await chrome.storage.local.set({
    [OAUTH_RESPONSE_KEY]: changeInfo.url
  });

  chrome.runtime.sendMessage({
    type: 'cortex.oauthCallback',
    url: changeInfo.url
  }).catch(() => {
    // The popup may be closed by the time Google redirects back.
  });

  chrome.tabs.remove(tabId).catch(() => {});
});

console.log('Cortex background service running.');
