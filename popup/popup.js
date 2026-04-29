import { supabase } from '../utils/supabase.js';
import StorageManager from '../memory/storage.js';

const authScreen = document.getElementById('auth-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const authMessage = document.getElementById('auth-message');
const counterUsed = document.getElementById('counter-used');
const counterBar = document.getElementById('counter-bar');
const limitWarning = document.getElementById('limit-warning');

// ---------------------------------------------------------------------------
// SHOW the right screen depending on login state
// ---------------------------------------------------------------------------
async function init() {
  const { data: { session } } = await supabase.auth.getSession();

  if (session) {
    showDashboard(session.user);
  } else {
    showAuth();
  }
}

function showAuth() {
  authScreen.classList.remove('hidden');
  dashboardScreen.classList.add('hidden');
}

async function showDashboard(user) {
  authScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');

  // Pull stats from local storage to show the counter
  const stats = await StorageManager.getStats();

  counterUsed.textContent = stats.total;
  counterBar.style.width = `${stats.percentage}%`;

  if (stats.limitReached) {
    limitWarning.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// GOOGLE LOGIN
// ---------------------------------------------------------------------------
document.getElementById('google-btn').addEventListener('click', async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: chrome.identity.getRedirectURL()
    }
  });
  if (error) showMessage(error.message);
});

// ---------------------------------------------------------------------------
// EMAIL SIGNUP
// ---------------------------------------------------------------------------
document.getElementById('signup-btn').addEventListener('click', async () => {
  const email = document.getElementById('email-input').value;
  const password = document.getElementById('password-input').value;

  if (!email || !password) {
    showMessage('Please enter your email and password.');
    return;
  }

  const { error } = await supabase.auth.signUp({ email, password });

  if (error) {
    showMessage(error.message);
  } else {
    showMessage('Check your email to confirm your account.');
  }
});

// ---------------------------------------------------------------------------
// EMAIL LOGIN
// ---------------------------------------------------------------------------
document.getElementById('login-btn').addEventListener('click', async () => {
  const email = document.getElementById('email-input').value;
  const password = document.getElementById('password-input').value;

  if (!email || !password) {
    showMessage('Please enter your email and password.');
    return;
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    showMessage(error.message);
  } else {
    showDashboard(data.user);
  }
});

// ---------------------------------------------------------------------------
// LOGOUT
// ---------------------------------------------------------------------------
document.getElementById('logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  showAuth();
});

// ---------------------------------------------------------------------------
// HELPER: show a message below the auth form
// ---------------------------------------------------------------------------
function showMessage(msg) {
  authMessage.textContent = msg;
}

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------
init();