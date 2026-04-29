// background.js
// Coordinates between extension pages, content scripts, and storage.

const OAUTH_CALLBACK_PATH = 'auth';
const OAUTH_RESPONSE_KEY = 'cortex.pendingOAuthResponseUrl';
const DEV_OAUTH_CALLBACK_ORIGIN = 'http://localhost:3000';

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;

  if (!isOAuthCallbackUrl(changeInfo.url)) return;

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

function isOAuthCallbackUrl(url) {
  const extensionRedirectUrl = chrome.identity.getRedirectURL(OAUTH_CALLBACK_PATH);

  if (url.startsWith(extensionRedirectUrl)) return true;

  try {
    const parsedUrl = new URL(url);

    return parsedUrl.origin === DEV_OAUTH_CALLBACK_ORIGIN &&
      (parsedUrl.searchParams.has('code') ||
        parsedUrl.searchParams.has('error') ||
        parsedUrl.hash.includes('access_token') ||
        parsedUrl.hash.includes('error'));
  } catch (error) {
    return false;
  }
}

console.log('Cortex background service running.');
