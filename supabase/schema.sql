-- SongNotes Supabase schema.
--
-- Apply this in your Supabase project's SQL Editor (https://supabase.com/dashboard
-- -> your project -> SQL Editor -> New query -> paste -> Run). This app never runs
-- migrations itself; you own the schema. The whole file is written to be safely
-- RE-RUNNABLE against an already-applied database (if not exists / if exists guards
-- throughout) -- to pick up a schema change, just paste and run this file again
-- rather than tracking separate incremental migration files.
--
-- Design: every song is always client-side encrypted (`content` is an opaque
-- envelope -- see src/crypto) -- Row Level Security ensures a user can only ever
-- see their own rows. Sync uses `rev` for optimistic concurrency (SongNotes-Android
-- docs/PLAN.md's "Phase 7... Tier 0" fix): a client only overwrites a row if its
-- `rev` still matches what the client last saw; on a lost race the client keeps
-- BOTH edits by writing its own as a new row rather than silently dropping one.
-- `deleted_at` is a tombstone, not a real DELETE -- so a delete on one device is
-- itself just another row version other devices' sync can see and reconcile
-- against, instead of a delete never propagating (the bug this fixes).

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
  -- If not encrypted (legacy rows only -- nothing writes these anymore): the plain
  -- song object { title, lines, createdAt, updatedAt, locked }.
  content jsonb not null,
  is_locked boolean not null default false,
  rev integer not null default 1,      -- optimistic-concurrency version, bumped on every write
  deleted_at timestamptz,              -- tombstone; null = not deleted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Existing databases: pick up the sync-v2 columns and drop the always-NULL title
-- column (every write is encrypted now, so a plaintext title column server-side
-- was dead weight that invited leaking titles server-side later "for speed").
alter table public.songs add column if not exists rev integer not null default 1;
alter table public.songs add column if not exists deleted_at timestamptz;
alter table public.songs drop column if exists title;

drop index if exists songs_user_id_idx;
create index if not exists songs_user_id_updated_at_idx on public.songs (user_id, updated_at);

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
