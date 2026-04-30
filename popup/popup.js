import { supabase } from '../utils/supabase.js';
import StorageManager from '../memory/storage.js';
import SettingsManager from '../memory/settings.js';
import Summarizer from '../memory/summarizer.js';

const authScreen = document.getElementById('auth-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const authMessage = document.getElementById('auth-message');
const redirectHint = document.getElementById('redirect-hint');
const counterUsed = document.getElementById('counter-used');
const counterBar = document.getElementById('counter-bar');
const limitWarning = document.getElementById('limit-warning');
const memoryInput = document.getElementById('memory-input');
const memoryTopicInput = document.getElementById('memory-topic-input');
const saveMemoryButton = document.getElementById('save-memory-btn');
const dashboardMessage = document.getElementById('dashboard-message');
const memoryList = document.getElementById('memory-list');
const providerSelect = document.getElementById('provider-select');
const apiKeyInput = document.getElementById('api-key-input');
const modelInput = document.getElementById('model-input');
const apiKeyWrap = document.getElementById('api-key-wrap');
const checkPromptAiButton = document.getElementById('check-prompt-ai-btn');
const saveSettingsButton = document.getElementById('save-settings-btn');
const settingsMessage = document.getElementById('settings-message');
const conversationInput = document.getElementById('conversation-input');
const extractMemoryButton = document.getElementById('extract-memory-btn');
const summarizerMessage = document.getElementById('summarizer-message');
const googleButton = document.getElementById('google-btn');
const signupButton = document.getElementById('signup-btn');
const loginButton = document.getElementById('login-btn');
const logoutButton = document.getElementById('logout-btn');
const OAUTH_RESPONSE_KEY = 'cortex.pendingOAuthResponseUrl';

window.addEventListener('error', (event) => {
  showMessage(`Startup error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  showMessage(`Auth error: ${getErrorMessage(event.reason)}`);
});

// ---------------------------------------------------------------------------
// SHOW the right screen depending on login state
// ---------------------------------------------------------------------------
async function init() {
  try {
    const { data: { session }, error } = await supabase.auth.getSession();

    if (error) throw error;

    if (session) {
      showDashboard(session.user);
    } else {
      showAuth();
      await completePendingOAuth();
    }
  } catch (error) {
    showAuth();
    showMessage(`Could not start auth: ${getErrorMessage(error)}`);
  }
}

function showAuth() {
  authScreen.classList.remove('hidden');
  dashboardScreen.classList.add('hidden');

  const redirectUrl = getOAuthRedirectUrl();
  redirectHint.textContent = `OAuth redirect URL: ${redirectUrl}. Dev fallback accepted: http://localhost:3000`;
}

async function showDashboard(user) {
  authScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');

  await refreshDashboard();
}

async function refreshDashboard() {
  // Pull stats from local storage to show the counter
  const stats = await StorageManager.getStats();

  counterUsed.textContent = stats.total;
  counterBar.style.width = `${stats.percentage}%`;

  if (stats.limitReached) {
    limitWarning.classList.remove('hidden');
  } else {
    limitWarning.classList.add('hidden');
  }

  await renderSettings();
  await renderMemoryList();
}

// ---------------------------------------------------------------------------
// GOOGLE LOGIN
// ---------------------------------------------------------------------------
googleButton.addEventListener('click', async () => {
  setButtonsDisabled(true);
  showMessage('Opening Google sign in...');

  try {
    const redirectTo = getOAuthRedirectUrl();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true
      }
    });

    if (error) throw error;
    if (!data?.url) throw new Error('Supabase did not return a Google sign-in URL.');

    await chrome.tabs.create({ url: data.url, active: true });
    showMessage('Finish Google sign-in in the new tab, then reopen Cortex.');
  } catch (error) {
    showMessage(getErrorMessage(error));
  } finally {
    setButtonsDisabled(false);
  }
});

// ---------------------------------------------------------------------------
// EMAIL SIGNUP
// ---------------------------------------------------------------------------
signupButton.addEventListener('click', async () => {
  const email = document.getElementById('email-input').value;
  const password = document.getElementById('password-input').value;

  if (!email || !password) {
    showMessage('Please enter your email and password.');
    return;
  }

  setButtonsDisabled(true);
  showMessage('Creating account...');

  try {
    const { error } = await supabase.auth.signUp({ email, password });

    if (error) {
      showMessage(error.message);
    } else {
      showMessage('Check your email to confirm your account.');
    }
  } catch (error) {
    showMessage(getErrorMessage(error));
  } finally {
    setButtonsDisabled(false);
  }
});

// ---------------------------------------------------------------------------
// EMAIL LOGIN
// ---------------------------------------------------------------------------
loginButton.addEventListener('click', async () => {
  const email = document.getElementById('email-input').value;
  const password = document.getElementById('password-input').value;

  if (!email || !password) {
    showMessage('Please enter your email and password.');
    return;
  }

  setButtonsDisabled(true);
  showMessage('Logging in...');

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      showMessage(error.message);
    } else {
      showMessage('');
      showDashboard(data.user);
    }
  } catch (error) {
    showMessage(getErrorMessage(error));
  } finally {
    setButtonsDisabled(false);
  }
});

// ---------------------------------------------------------------------------
// MANUAL MEMORY TEST
// ---------------------------------------------------------------------------
saveMemoryButton.addEventListener('click', async () => {
  const fact = memoryInput.value.trim();
  const topic = memoryTopicInput.value.trim() || 'general';

  if (!fact) {
    showDashboardMessage('Enter a memory first.');
    return;
  }

  saveMemoryButton.disabled = true;
  showDashboardMessage('Saving memory...');

  try {
    const result = await StorageManager.saveMemory(fact, 'manual', topic);

    if (!result.success && result.reason === 'limit_reached') {
      showDashboardMessage('Free memory limit reached.');
      return;
    }

    memoryInput.value = '';
    memoryTopicInput.value = '';
    await refreshDashboard();

    if (result.serverSync?.success) {
      showDashboardMessage(`Saved. Server count: ${result.serverSync.count}`);
    } else if (result.duplicate) {
      showDashboardMessage('Memory already existed. Use count updated.');
    } else if (result.serverSync?.message) {
      showDashboardMessage(`Saved locally. Counter sync failed: ${result.serverSync.message}`);
    } else {
      showDashboardMessage('Saved locally.');
    }
  } catch (error) {
    showDashboardMessage(getErrorMessage(error));
  } finally {
    saveMemoryButton.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// AI SETTINGS
// ---------------------------------------------------------------------------
providerSelect.addEventListener('change', () => {
  const provider = providerSelect.value;
  modelInput.value = SettingsManager.getDefaultModel(provider);
  toggleApiKeyFields(provider);
});

function toggleApiKeyFields(provider) {
  const needsKey = provider !== 'chrome-ai';
  apiKeyWrap.style.display = needsKey ? '' : 'none';
  checkPromptAiButton.classList.toggle('hidden', needsKey);
}

checkPromptAiButton.addEventListener('click', async () => {
  checkPromptAiButton.disabled = true;
  showSettingsMessage('Checking Prompt AI...');

  try {
    const result = await sendRuntimeMessage({ type: 'cortex.promptAiStatus' });

    if (result.success) {
      showSettingsMessage(`Prompt AI session works. Availability reported: ${result.available}.`);
    } else {
      showSettingsMessage(result.error || `Prompt AI status: ${result.available || 'unknown'}`);
    }
  } catch (error) {
    showSettingsMessage(getErrorMessage(error));
  } finally {
    checkPromptAiButton.disabled = false;
  }
});

saveSettingsButton.addEventListener('click', async () => {
  saveSettingsButton.disabled = true;
  showSettingsMessage('Saving settings...');

  try {
    const settings = await SettingsManager.saveSettings({
      provider: providerSelect.value,
      apiKey: apiKeyInput.value,
      model: modelInput.value
    });

    apiKeyInput.value = settings.apiKey;
    modelInput.value = settings.model;
    showSettingsMessage('Settings saved locally.');
  } catch (error) {
    showSettingsMessage(getErrorMessage(error));
  } finally {
    saveSettingsButton.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// SUMMARIZER TEST
// ---------------------------------------------------------------------------
extractMemoryButton.addEventListener('click', async () => {
  const conversationText = conversationInput.value.trim();

  if (!conversationText) {
    showSummarizerMessage('Paste conversation text first.');
    return;
  }

  extractMemoryButton.disabled = true;
  showSummarizerMessage('Extracting memories...');

  try {
    const settings = await SettingsManager.getSettings();

    if (settings.provider === 'chrome-ai') {
      const result = await extractMemoriesInBackground('summarizer', conversationText);

      if (!result.success) throw new Error(result.error || 'Prompt AI extraction failed.');

      conversationInput.value = '';
      await refreshDashboard();
      showSummarizerMessage(`Extracted ${result.extracted || 0}, saved ${result.saved || 0}.`);
      return;
    }

    const memories = await Summarizer.extractMemories(conversationText);

    if (!memories.length) {
      showSummarizerMessage('No durable memories found.');
      return;
    }

    let saved = 0;
    let failedSync = 0;

    for (const memory of memories) {
      const result = await StorageManager.saveMemory(memory.fact, 'summarizer', memory.topic);

      if (result.success) saved += 1;
      if (result.serverSync?.success === false) failedSync += 1;
    }

    conversationInput.value = '';
    await refreshDashboard();
    showSummarizerMessage(`Extracted ${memories.length}, saved ${saved}${failedSync ? `, ${failedSync} sync warning${failedSync === 1 ? '' : 's'}` : ''}.`);
  } catch (error) {
    showSummarizerMessage(getErrorMessage(error));
  } finally {
    extractMemoryButton.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// LOGOUT
// ---------------------------------------------------------------------------
logoutButton.addEventListener('click', async () => {
  setButtonsDisabled(true);

  try {
    await supabase.auth.signOut();
    showAuth();
    showMessage('');
  } catch (error) {
    showMessage(getErrorMessage(error));
  } finally {
    setButtonsDisabled(false);
  }
});

// ---------------------------------------------------------------------------
// HELPER: show a message below the auth form
// ---------------------------------------------------------------------------
function showMessage(msg) {
  authMessage.textContent = msg;
}

function showDashboardMessage(msg) {
  dashboardMessage.textContent = msg;
}

function showSettingsMessage(msg) {
  settingsMessage.textContent = msg;
}

function showSummarizerMessage(msg) {
  summarizerMessage.textContent = msg;
}

function setButtonsDisabled(disabled) {
  googleButton.disabled = disabled;
  signupButton.disabled = disabled;
  loginButton.disabled = disabled;
  logoutButton.disabled = disabled;
}

function getOAuthRedirectUrl() {
  return chrome.identity.getRedirectURL('auth');
}

function extractMemoriesInBackground(platform, text) {
  return sendRuntimeMessage({ type: 'cortex.extractMemories', platform, text });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      message,
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      }
    );
  });
}

async function completeOAuth(responseUrl) {
  const url = new URL(responseUrl);

  const authError = url.searchParams.get('error_description') ||
    url.searchParams.get('error') ||
    new URLSearchParams(url.hash.replace(/^#/, '')).get('error_description') ||
    new URLSearchParams(url.hash.replace(/^#/, '')).get('error');

  if (authError) throw new Error(authError);

  const code = url.searchParams.get('code');

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) throw error;
    await clearPendingOAuth();
    showMessage('');
    showDashboard(data.user);
    return;
  }

  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');

  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    });

    if (error) throw error;
    await clearPendingOAuth();
    showMessage('');
    showDashboard(data.user);
    return;
  }

  throw new Error('Google sign-in did not return a usable session.');
}

async function completePendingOAuth() {
  const result = await chrome.storage.local.get([OAUTH_RESPONSE_KEY]);
  const responseUrl = result[OAUTH_RESPONSE_KEY];

  if (!responseUrl) return;

  showMessage('Completing Google sign-in...');
  await completeOAuth(responseUrl);
}

async function clearPendingOAuth() {
  await chrome.storage.local.remove([OAUTH_RESPONSE_KEY]);
}

async function renderMemoryList() {
  const memories = await StorageManager.getMemories();
  const latest = memories.slice(0, 5);

  if (!latest.length) {
    memoryList.innerHTML = '<div class="empty-state">No memories stored yet.</div>';
    return;
  }

  memoryList.innerHTML = latest.map((memory) => `
    <div class="memory-item">
      <div class="memory-fact">${escapeHtml(memory.fact)}</div>
      <div class="memory-meta">${escapeHtml(memory.topic)} &middot; ${escapeHtml(memory.platform)} &middot; ${memory.uses} use${memory.uses === 1 ? '' : 's'}</div>
    </div>
  `).join('');
}

async function renderSettings() {
  const settings = await SettingsManager.getSettings();

  providerSelect.value = settings.provider;
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  toggleApiKeyFields(settings.provider);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'cortex.oauthCallback') return;

  completeOAuth(message.url).catch((error) => {
    showMessage(getErrorMessage(error));
  });
});

// Refresh the counter and memory list whenever the background saves new memories
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.memories) return;
  if (!dashboardScreen.classList.contains('hidden')) {
    refreshDashboard();
  }
});

function getErrorMessage(error) {
  if (!error) return 'Something went wrong.';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
}

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------
init();
