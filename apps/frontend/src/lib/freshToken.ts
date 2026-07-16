import { supabase } from './supabase';

// Returns a valid access token, refreshing the Supabase session if it has
// expired (or is about to). Prevents the 401-then-TOKEN_REFRESHED race where
// React state still holds the previous token at fetch time.
export async function freshAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
