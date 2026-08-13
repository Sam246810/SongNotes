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
--
-- `envelope_rev` guards writes the same way `songs.rev` does: every writer must
-- read the current rev and only overwrite if it still matches (see
-- SupabaseUserKeysAdapter.update). This row is the ONE thing in the whole schema
-- whose loss is unrecoverable-by-construction -- a blind overwrite here can
-- silently swap in an envelope for a brand-new DEK, permanently orphaning every
-- song encrypted under the old one. `songs` already had this guard; `user_keys`
-- didn't, which is a real bug this column exists to close.
create table if not exists public.user_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  envelope jsonb not null,       -- { kdf params + salt, wrapped DEK, wrapped-by-recovery-code DEK }
  envelope_rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_keys add column if not exists envelope_rev integer not null default 1;

-- Append-only history of every previous envelope for a user, written automatically
-- whenever a row in user_keys is updated (see the trigger below) -- cheap insurance
-- for a zero-knowledge product: if any client bug ever overwrites a live envelope
-- with one for the wrong DEK, the previous envelope (with its still-valid recovery
-- wrap) is sitting right here instead of gone forever. This leaks nothing new --
-- these rows are the exact same wrapped ciphertext the server already held in
-- `user_keys.envelope`, which it could never read either way.
create table if not exists public.user_keys_history (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  envelope jsonb not null,
  archived_at timestamptz not null default now()
);

create or replace function public.archive_user_keys_envelope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_keys_history (user_id, envelope)
  values (old.user_id, old.envelope);
  return new;
end;
$$;

drop trigger if exists user_keys_archive_on_update on public.user_keys;
create trigger user_keys_archive_on_update
  before update on public.user_keys
  for each row
  when (old.envelope is distinct from new.envelope)
  execute function public.archive_user_keys_envelope();

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted boolean not null default true,
  -- If encrypted: { content: {iv,ct}, ck: { wrappedByDek | wrappedBySong } } (see src/crypto).
  -- If not encrypted (legacy rows only -- nothing writes these anymore): the plain
  -- song object { title, lines, createdAt, updatedAt, locked }.
  content jsonb not null,
  is_locked boolean not null default false,
  -- Which account DEK (user_keys.envelope.dekId) this row's `content` is encrypted
  -- under. Nullable -- rows written before this column existed have no way to
  -- backfill it retroactively, so a null dek_id is read as "assume the current
  -- key" rather than enforced NOT NULL. Its purpose: after a DEK rotation
  -- (recovery-code-lost reset, see src/auth/accountRecovery.js's rotateAndPurge),
  -- a client can tell "encrypted under a previous key" apart from "corrupt/
  -- undecryptable" BEFORE attempting a decrypt that's guaranteed to fail, and
  -- the Android sync engine uses it to refuse to push local edits that would
  -- otherwise silently resurrect dead-key ciphertext after a purge.
  dek_id text,
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
alter table public.songs add column if not exists dek_id text;
alter table public.songs drop column if exists title;

drop index if exists songs_user_id_idx;
create index if not exists songs_user_id_updated_at_idx on public.songs (user_id, updated_at);

alter table public.user_keys enable row level security;
alter table public.user_keys_history enable row level security;
alter table public.songs enable row level security;

drop policy if exists "own keys" on public.user_keys;
create policy "own keys" on public.user_keys
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Read-only from the client's side, deliberately -- rows are written only by the
-- archive_user_keys_envelope trigger (SECURITY DEFINER, so RLS doesn't block it),
-- never directly by client code. No insert/update/delete policy is created.
drop policy if exists "own key history" on public.user_keys_history;
create policy "own key history" on public.user_keys_history
  for select
  using (auth.uid() = user_id);

drop policy if exists "own songs" on public.songs;
create policy "own songs" on public.songs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
