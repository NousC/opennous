import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    '[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Auth features will not work until these are set. ' +
      'Please add these to your .env file and restart the dev server.'
  );
}

// Key used to store the "remember me" preference
const REMEMBER_ME_KEY = 'nous_remember_me';

// Helper to set the remember me preference (call before sign in)
export const setRememberMe = (remember: boolean) => {
  localStorage.setItem(REMEMBER_ME_KEY, remember ? 'true' : 'false');
};

// Helper to get the remember me preference
export const getRememberMe = (): boolean => {
  return localStorage.getItem(REMEMBER_ME_KEY) !== 'false';
};

// Custom storage adapter that uses localStorage or sessionStorage based on preference
const customStorageAdapter = {
  getItem: (key: string): string | null => {
    const localValue = localStorage.getItem(key);
    if (localValue) return localValue;
    return sessionStorage.getItem(key);
  },
  setItem: (key: string, value: string): void => {
    // If the session already exists in one of the storages, keep it there.
    // This prevents token auto-refreshes from silently migrating the session
    // between storages when the rememberMe preference changes after login.
    // Only consult the preference when storing a brand-new session.
    const existsInLocal = localStorage.getItem(key) !== null;
    const existsInSession = sessionStorage.getItem(key) !== null;
    const useLocal = existsInLocal || (!existsInSession && getRememberMe());

    if (useLocal) {
      localStorage.setItem(key, value);
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, value);
      localStorage.removeItem(key);
    }
  },
  removeItem: (key: string): void => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

// Create Supabase client with error handling
// Use empty strings as fallback to prevent crashes, but auth won't work
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: customStorageAdapter,
    },
  }
);

