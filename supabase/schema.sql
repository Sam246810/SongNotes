-- SongNotes Supabase schema.
--
-- Apply this in your Supabase project's SQL Editor (https://supabase.com/dashboard
-- -> your project -> SQL Editor -> New query -> paste -> Run). This app never runs
-- migrations itself; you own the schema.
--
-- Design: the `songs` table stores EITHER plaintext (encrypted = false, chosen by the
-- user per song) OR an opaque client-side-encrypted envelope (encrypted = true) in
-- `content`. When encrypted, the title lives inside the envelope too (not the `title`
-- column) so it's never readable server-side. Row Level Security ensures a user can
-- only ever see their own rows, regardless of encryption choice.

create extension if not exists pgcrypto;

-- One row per user: holds their wrapped Data Encryption Key (DEK), created lazily
-- the first time they choose to encrypt a song (not at signup).
create table if not exists public.user_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  envelope jsonb not null,       -- { kdf params + salt, wrapped DEK, wrapped-by-recovery-code DEK }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted boolean not null default true,
  -- If encrypted: { content: {iv,ct}, ck: { wrappedByDek | wrappedBySong } } (see src/crypto).
  -- If not encrypted: the plain song object { title, lines, createdAt, updatedAt, locked }.
  content jsonb not null,
  title text,                    -- plaintext title, ONLY set when encrypted = false (fast listing)
  is_locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists songs_user_id_idx on public.songs (user_id);

alter table public.user_keys enable row level security;
alter table public.songs enable row level security;

drop policy if exists "own keys" on public.user_keys;
create policy "own keys" on public.user_keys
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own songs" on public.songs;
create policy "own songs" on public.songs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
