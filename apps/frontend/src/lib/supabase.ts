// Authentication moved to Clerk (see contexts/AuthContext). This module used to
// create the Supabase auth client; it now only carries the "remember me"
// preference helpers that the auth pages still import. Clerk manages its own
// session persistence, so these are advisory only and kept for compatibility.

const REMEMBER_ME_KEY = 'nous_remember_me';

export const setRememberMe = (remember: boolean) => {
  try {
    localStorage.setItem(REMEMBER_ME_KEY, remember ? 'true' : 'false');
  } catch { /* sandbox / private mode */ }
};

export const getRememberMe = (): boolean => {
  try {
    return localStorage.getItem(REMEMBER_ME_KEY) !== 'false';
  } catch {
    return true;
  }
};
