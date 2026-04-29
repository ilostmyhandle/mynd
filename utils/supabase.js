import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://sahofpwvfogzcmkivhjk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaG9mcHd2Zm9nemNta2l2aGprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NDk5NDAsImV4cCI6MjA5MzAyNTk0MH0.EADoCeK6cOjCxUBopPm-Hyb22zsL_Tz-mIhcjZcbqr8';

const chromeStorageAdapter = {
  getItem: async (key) => {
    const result = await chrome.storage.local.get([key]);
    return result[key] || null;
  },
  setItem: async (key, value) => {
    await chrome.storage.local.set({ [key]: value });
  },
  removeItem: async (key) => {
    await chrome.storage.local.remove([key]);
  }
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
    persistSession: true,
    storage: chromeStorageAdapter
  }
});
