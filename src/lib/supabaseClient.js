import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// The anon key is public-by-design (it ships in the client bundle); Row Level
// Security on the Supabase tables is what actually scopes access per user, and
// client-side encryption (src/crypto/) is what keeps encrypted song content
// unreadable even to someone with full database access.
export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured ? createClient(url, anonKey) : null;

if (!isSupabaseConfigured && import.meta.env.DEV) {
  console.warn(
    'SongNotes: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — accounts and cloud sync are disabled, guest mode only. See .env.example.'
  );
}
