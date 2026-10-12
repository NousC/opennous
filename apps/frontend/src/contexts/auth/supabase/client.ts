import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The browser Supabase client for self-host auth (GET-577). Anon key only —
// never the service role. Used for sign-in/sign-up/session; the app's data
// still goes through apps/api, never straight to the database.
//
// flowType stays 'implicit' (the default): admin-generated magic links (admin
// impersonation, agency claim links) carry the session in the URL hash, which
// detectSessionInUrl picks up on /login.
let client: SupabaseClient | null = null;

export function getSupabaseAuthClient(): SupabaseClient {
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (required for Supabase auth)");
  }
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

// Supabase returns { message }; pass it through, with a fallback.
export function supabaseError(error: any) {
  return error ? { message: error.message || "Something went wrong. Please try again." } : null;
}
