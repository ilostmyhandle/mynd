import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://sahofpwvfogzcmkivhjk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaG9mcHd2Zm9nemNta2l2aGprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NDk5NDAsImV4cCI6MjA5MzAyNTk0MH0.EADoCeK6cOjCxUBopPm-Hyb22zsL_Tz-mIhcjZcbqr8';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);