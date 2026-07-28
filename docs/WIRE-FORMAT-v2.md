# SongNotes Wire Format v2

This is the shared contract between the desktop web app (`SongNotes`, React/JS) and
the Android app (`SongNotes-Android`, Kotlin). It is **committed identically to both
repos**. If you change this file, change it in both places in the same sitting, and
bump the version number of whichever section you touched.

Two independent implementations of one format will drift unless the contract is
explicit and tested. Section 7 lists the test vectors both repos must carry.

**Status:** v2 is a clean break from v1 (the web app's current format, documented in
Appendix A). Nothing needs to read v1 except a one-time migration on the web side —
see Section 6.

---

## 1. Database schema (Supabase / Postgres)

```sql
create extension if not exists pgcrypto;

create table if not exists public.user_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  envelope jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dek_id text not null,              -- which DEK this row is encrypted under; see §3
  content jsonb not null,            -- {v, alg, iv, ct} — see §2, always encrypted
  rev bigint not null default 1,     -- optimistic-concurrency counter; see §5
  deleted_at timestamptz,            -- tombstone; null = alive
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists songs_user_id_updated_at_idx on public.songs (user_id, updated_at);

create or replace function public.songs_bump_rev()
returns trigger language plpgsql as $$
begin
  new.rev = old.rev + 1;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists songs_bump_rev_trigger on public.songs;
create trigger songs_bump_rev_trigger
  before update on public.songs
  for each row execute function public.songs_bump_rev();

alter table public.user_keys enable row level security;
alter table public.songs enable row level security;

drop policy if exists "own keys" on public.user_keys;
create policy "own keys" on public.user_keys for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own songs" on public.songs;
create policy "own songs" on public.songs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Changes from v1, and why:

- **No `title` or `is_locked` columns.** In v1 `title` was always written `NULL` (the
  real title lives inside the ciphertext) — a trap that invites a future "optimize
  the list view" leak. Dropped entirely.
- **`dek_id` added, not nullable.** Every song row states which DEK encrypted it.
  Makes "this song predates a key reset" identifiable instead of "decrypt just
  threw". See §3.
- **`rev` + a DB-side trigger**, not client-supplied. The trigger is the source of
  truth so a client can never forge a revision bump. Used for optimistic-concurrency
  writes — see §5.
- **`deleted_at` tombstone.** v1 never propagated deletes between devices. A client
  soft-deletes by setting this column; a sync pull must apply tombstones, not just
  upsert rows it sees.
- **`(user_id, updated_at)` composite index** replaces the single-column one, so an
  incremental pull (`where user_id = ? and updated_at > ?`) is indexed.

---

## 2. Encrypted row content — `{v, alg, iv, ct}`

Every `songs.content` and every individual "wrap" inside `user_keys.envelope` uses
the **same envelope shape**:

```json
{ "v": 1, "alg": "AES-GCM", "iv": "<base64>", "ct": "<base64>" }
```

- **Cipher:** AES-GCM, 256-bit key.
- **IV:** exactly **12 bytes**, cryptographically random, freshly generated on
  **every** encrypt call. Never reused, never derived, never caller-supplied.
- **Tag:** GCM's default **128-bit** authentication tag, **appended to the
  ciphertext** (`ct` = ciphertext ‖ tag). This is what both WebCrypto's
  `crypto.subtle.encrypt` and Java `Cipher.getInstance("AES/GCM/NoPadding")` produce
  and consume natively — no splitting or reassembly needed on either side.
  Kotlin: `GCMParameterSpec(128, iv)`.
- **AAD (additional authenticated data):** **none.** Do not pass any.
- **Base64:** standard RFC 4648 alphabet (`A–Z a–z 0–9 + /`), **padded with `=`**,
  no line breaks. **Not** URL-safe. Kotlin: `java.util.Base64.getEncoder()` /
  `getDecoder()` (API 26+), *not* `Base64.URL_SAFE`.
- **`alg` is always the literal string `"AES-GCM"`.** `v` is the envelope shape
  version (currently `1` — this is a different, inner version number from the outer
  document's "v2"; don't conflate them).

**Plaintext of `songs.content`** — the JSON document described in §4, UTF-8 encoded,
then encrypted whole. Nothing about individual fields is separately encrypted.

### Key-wrapping (`wrapped` field)

Wrapping a key (rather than arbitrary JSON) uses the same envelope shape but the
field is named `wrapped`, not `ct`:

```json
{ "v": 1, "alg": "AES-GCM", "iv": "<base64>", "wrapped": "<base64>" }
```

`wrapped` = `AES-GCM-encrypt(kek, iv, keyBytes)` where `keyBytes` is the **bare
32-byte AES key** (no key-blob header, no JWK, no PKCS#8, no length prefix). A
256-bit key wrapped this way is `32 + 16 (tag) = 48` raw bytes → 64 base64
characters.

- **Web (encrypt):** `crypto.subtle.wrapKey('raw', dek, kek, {name:'AES-GCM', iv})`.
- **Web (decrypt):** `crypto.subtle.unwrapKey('raw', wrapped, kek, {name:'AES-GCM', iv}, {name:'AES-GCM', length:256}, true, [...])`.
- **Android:** there is no `wrapKey` primitive in `javax.crypto` — it's just
  `Cipher.doFinal(dekBytes)` under the KEK, and `SecretKeySpec(decryptedBytes, "AES")`
  on the way back.

---

## 3. Account key envelope — `user_keys.envelope`

```json
{
  "v": 2,
  "dekId": "<12 random bytes, base64url, no padding>",
  "alg": "AES-256-GCM",
  "wraps": [
    {
      "id": "pass",
      "type": "passphrase",
      "kdf": { "name": "Argon2id", "v": 19, "m": 65536, "t": 3, "p": 1, "salt": "<base64>" },
      "iv": "<base64>", "ct": "<base64>"
    },
    {
      "id": "recovery",
      "type": "recovery-code",
      "kdf": { "name": "Argon2id", "v": 19, "m": 65536, "t": 3, "p": 1, "salt": "<base64>" },
      "iv": "<base64>", "ct": "<base64>"
    }
  ],
  "verifier": { "iv": "<base64>", "ct": "<base64, AES-GCM(DEK, iv, \"songnotes-dek-check-v2\")>" },
  "createdAt": "<ISO 8601>", "updatedAt": "<ISO 8601>"
}
```

Notes on each field:

- **`wraps` is a list, not two fixed named fields (unlike v1).** Each entry's `iv`/`ct`
  fields are the **key-wrap** envelope shape from §2 (field name `wrapped`, not
  `ct`... — see correction below). A client that doesn't recognize a `type` (e.g. a
  future `"device"` or `"webauthn"` wrap) must skip it, not error.

  > Correction for implementers: the wrap object nests the whole wrap-envelope
  > **inside** `wraps[i]`, i.e. `wraps[i] = {id, type, kdf, iv, ct}` where `ct` here
  > is actually the wrapped-key ciphertext (following the `wrapped` semantics of
  > §2's key-wrap shape, just spelled `ct` at this nesting level for brevity). Treat
  > `wraps[i].{iv, ct}` as "wrap the DEK's 32 raw bytes with the KEK derived from
  > `kdf`", identical math to §2's key-wrap section.

- **Each `wraps[i]` has its OWN salt and OWN IV.** The passphrase and recovery-code
  branches are cryptographically independent; compromising one KDF input never
  helps against the other.
- **`kdf.name` is checked per-wrap, not assumed.** A reader must dispatch on
  `kdf.name` (`"Argon2id"` or, only for legacy v1 envelopes upgraded in place,
  `"PBKDF2"` — see §6). **Never hardcode the algorithm.**
- **Argon2id parameters:** `m=65536` (64 MiB, in **KiB** per the Argon2 spec —
  double-check your library's unit), `t=3` iterations, `p=1` lane, 16-byte salt,
  32-byte (256-bit) output, version `19` (0x13, i.e. Argon2 v1.3). This is OWASP's
  first recommended profile as of 2024–2026 guidance.
- **`dekId`**: 12 random bytes, base64url **without padding** (so it's safe to use
  directly as e.g. a filename component or column value with no escaping). Every
  `songs.dek_id` must match the `dekId` currently active in `user_keys.envelope` for
  that user, or the song predates a key reset (§3.3) and should render as
  "encrypted under a previous key" rather than a generic decrypt failure.
- **`verifier`**: `AES-GCM-encrypt(dek, freshIv, utf8("songnotes-dek-check-v2"))`.
  After deriving a candidate DEK from a passphrase/recovery-code attempt, decrypt
  `verifier` and check the plaintext equals exactly `"songnotes-dek-check-v2"`. This
  tells you "right passphrase" or "wrong passphrase" **without touching any song
  ciphertext** — v1 had to attempt a real song decrypt to find out.

### 3.1 Recovery code format

Unchanged from v1 — this format was already good:

- 20 random bytes → mapped **unbiased** via `byte % 32` (256 is a multiple of 32, so
  every output symbol is equally likely) onto the alphabet
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 chars — excludes `0/O`, `1/I/L` for
  unambiguous handwriting/reading).
- One character per byte → 20 characters → **100 bits of entropy** (5 bits/byte
  survive the modulo; the raw 160 bits of input is not the code's actual entropy).
- Hyphenated every 5th character except the last: `XXXXX-XXXXX-XXXXX-XXXXX` (23
  characters total including hyphens).

**New in v2 — normalize before deriving, on both platforms:**

```
normalize(input) = insert '-' every 5 chars into
                    uppercase(input).filter { it in ALPHABET }
```

i.e. uppercase, strip every character not in the 32-char alphabet (including
existing hyphens, spaces, anything pasted), then re-insert canonical hyphens. Derive
the KEK from the **normalized** string, not the raw user input. This fixes a v1
footgun: retyping a recovery code without hyphens used to just fail as "wrong code".

### 3.2 Device key wrap — Android-local only, not synced

Android additionally maintains a **local-only** Room row (never sent to Supabase):

```
device_key_wrap(dek_id TEXT PRIMARY KEY, iv BLOB, ct BLOB, keystore_alias TEXT)
```

`ct` = the DEK wrapped by an AES-256-GCM key held in Android Keystore
(`setUserAuthenticationRequired(true)`, biometric-or-device-credential gated,
`setInvalidatedByBiometricEnrollment(true)`, StrongBox when available). This lets a
user type their passphrase once per device and unlock with a fingerprint afterward.
**This has no web equivalent and is never part of the synced envelope** — the server
and the web client know nothing about it.

### 3.3 Flows (normative — implement exactly this on both platforms)

- **New account, first encryption setup:** generate `dek = random(32 bytes)`,
  generate `dekId`, build both wraps (passphrase and/or recovery-code — see the
  "recovery-code only" onboarding note in the Android plan for the case where the
  user has no separate passphrase), build `verifier`, upsert `user_keys`.
- **Unlock (existing envelope, have a candidate secret):** find the matching
  `wraps[]` entry by `type`, derive KEK via that entry's `kdf`, unwrap → candidate
  DEK, decrypt `verifier` with the candidate DEK, compare plaintext. Mismatch = wrong
  secret, full stop — do not fall through to trying to decrypt a song to "double
  check".
- **Passphrase change:** requires the current passphrase or recovery code (DEK must
  already be in hand). New salt, new KEK, replace only the `pass` wrap entry.
  **The DEK itself never changes** — zero songs need re-encryption. The `recovery`
  wrap is untouched, so the original recovery code keeps working forever unless the
  user explicitly resets.
- **Full reset (DEK rotation — last resort, destroys access to existing songs):**
  generate a brand new `dek` + `dekId`, rebuild every wrap, **and re-encrypt every
  song** the user still wants to keep (they become unreadable otherwise, since their
  `dek_id` no longer matches anything unlockable). This is the only flow that is
  O(song count) and must say so in the UI.
- **KDF upgrade on unlock:** if a matched `wraps[]` entry's `kdf` params are below
  current policy (e.g. a legacy PBKDF2 entry, or a lower Argon2 `t`/`m` than today's
  default), rewrap that entry with current params **as a side effect of a successful
  unlock**, and upsert. Silent, incremental fleet-wide upgrade.

---

## 4. Song document (inside `content`'s decrypted plaintext)

```json
{
  "v": 2,
  "id": "<uuid v4>",
  "dekId": "<matches the wraps envelope that can decrypt this row>",
  "title": "Amazing Grace",
  "meta": { "bpm": 82, "key": "G", "tuning": "EADGBE", "capo": 0 },
  "lines": [
    {
      "id": "<uuid v4>",
      "lyrics": "Amazing grace, how sweet the sound",
      "chords": [ { "i": 0, "c": "G" }, { "i": 14, "c": "C" } ]
    }
  ],
  "customChords": {
    "G": { "frets": [3, 2, 0, 0, 0, 3], "baseFret": 1 }
  },
  "createdAt": "<ISO 8601>",
  "updatedAt": "<ISO 8601>"
}
```

Field-by-field, and what changed from v1:

- **`meta.bpm` / `meta.capo` are numbers, not strings.** v1 had them as `''`-default
  strings for no real reason. `bpm: 0` and `capo: 0` both mean "unset" (there's no
  meaningful song at 0 BPM, so this is an unambiguous sentinel — don't use `null`,
  keep the type a plain number everywhere). `meta.key`/`meta.tuning` stay strings,
  empty string = unset.
- **`chords` is a list of anchors `{i, c}`, not a parallel padded string
  (the single biggest change from v1).** `i` is the **character index into
  `lyrics`** (0-based, UTF-16 code unit index — both JS strings and Kotlin/Java
  `String` index this way, so no conversion is needed) where the chord is
  positioned; `c` is the raw chord text **exactly as the user typed it**
  (un-normalized — normalization for lookup/rendering happens at read time via the
  ported `normalizeChordName`, never baked into storage). Anchors are sorted
  ascending by `i`; **`i` may legitimately exceed `lyrics.length`** (a chord placed
  past the end of a short lyric line, or on an instrumental-only line with empty
  `lyrics`) — that is valid and must round-trip, not be clamped or dropped.
  - **Converting v1's padded string → v2 anchors:** scan the chords string for
    maximal non-whitespace runs; each run's start column becomes `i`, its text
    becomes `c`.
  - **Converting v2 anchors → a v1-style padded string** (for plain-text chord-sheet
    export, which stays column-based on purpose): start with a string of spaces the
    length of `lyrics` (or longer if any `i + len(c) > lyrics.length`), then
    overwrite at each `i`. This conversion is lossless in the anchors→string
    direction only if no two chords' rendered spans overlap after normalization —
    both platforms must use the **same** overlap-resolution rule (later anchor in
    sort order wins the overlapping columns) since plain-text export has no way to
    represent two chords at the same column.
- **`customChords`** — unchanged from v1. Keyed by **normalized** chord name (via
  the ported `normalizeChordName`). Value: `{ frets: [6 ints], baseFret: int }`.
  `frets` is `[lowE, A, D, G, B, highE]`; `-1` = muted, `0` = open, `1..24` = fret
  number. `baseFret` is the display window's starting fret (1 = open position).
  Never carries a `barre` key (that's a built-in-chord-database-only field, not
  user-authored).
- **`dekId`** — stamped at encryption time from the currently-active `dekId`. A
  reader compares this against the DEK it holds; on mismatch, render the song as
  "from an older encryption key" rather than attempting to decrypt (it will fail
  anyway, but the distinguishable error is better UX — see §3).
- Removed from v1 entirely, never sent: `isReadOnly` (was a local-only UI toggle),
  the per-song `encrypted` boolean (encryption is now unconditional — see §6, there
  is no plaintext-song mode in v2).

---

## 5. Sync protocol

**Offline-first on both platforms.** The UI reads only from local storage (Room on
Android, the existing local cache pattern on web); network sync is a background
process that reconciles local state with the server, never a read path.

### 5.1 Push (optimistic concurrency, "Tier 0")

```sql
update songs
set content = $1, rev = rev + 1, updated_at = now()
where id = $2 and rev = $base_rev;
```

(The `rev` column also has the DB trigger from §1 bumping it on any update — the
explicit `rev = rev + 1` here is belt-and-braces; the important part of the
statement is the `where ... and rev = $base_rev` optimistic-concurrency guard.)

- **0 rows affected** = someone else wrote since you last synced. Fetch the current
  remote row. If its decrypted content differs from your local base (the version you
  last synced, not your current edit), **do not overwrite it.** Instead:
  1. Leave the remote row as-is (it's now canonical for that `id`).
  2. Insert your local edit as a **new row** with a new `id`, titled
     `"<original title> (conflict copy — <device name>, <local time>)"`.
  3. Surface both to the user. This is deliberately Dropbox's conflicted-copy model:
     inelegant, but lossless and immediately understandable. Never silently drop
     either side.
- **New song:** plain `insert`, client-generated `id` (uuid v4), `rev` defaults to 1
  via the column default.
- **Delete:** `update songs set deleted_at = now() where id = $1` — never a real SQL
  `delete`. A hard delete is fine as a periodic server-side sweep of old tombstones
  (e.g. >90 days), but that's a maintenance job, not something either client does
  inline.

### 5.2 Pull

```sql
select * from songs
where user_id = $1 and updated_at > $2  -- $2 = local last_sync_at
order by updated_at asc;
```

- Rows with `deleted_at is not null` → apply as a local delete/tombstone, not an
  upsert.
- Rows with `deleted_at is null` → decrypt (skip + mark "locked" on failure, same as
  v1's placeholder pattern — never throw and block the whole list) and upsert
  locally, tracking the row's own `rev` as the new local `base_rev` for that song.
- Advance local `last_sync_at` to the latest `updated_at` seen (or to "now" at pull
  start, whichever your client already tracks — be consistent, don't miss the
  boundary row).

### 5.3 Explicitly out of scope for v2

- **Per-line 3-way merge** ("Tier 1") — real, and worth building once the product UI
  exists, but not part of this initial contract. When it lands, it operates entirely
  client-side on **decrypted** content (never sent to the server as a diff/op-log),
  so it doesn't change anything in this document. Lines already carry stable `id`s,
  which is what makes it feasible later.
- **CRDTs / operational transforms.** Not planned. Would require encrypting an
  append-only op log instead of a single blob per song, a second native
  toolchain most likely, and a much harder cross-platform agreement surface than a
  JSON document. Not worth it for a single-user, few-device product.

---

## 6. Migration notes (web app only — Android has no v1 to migrate from)

The web app currently writes v1 (PBKDF2-600k, padded-string chords, string
bpm/capo, no `rev`/`dek_id`/`deleted_at`). Recommended approach, **not required
before Android development starts** (Android is greenfield against v2 from day
one):

1. Schema: add the new columns (`dek_id`, `rev`, `deleted_at`) as nullable/defaulted
   migrations; drop `title`/`is_locked` only once no code path still writes them.
2. Envelope: add a v1→v2 **reader** (recognize `envelope.v === 1`, synthesize a
   single-entry `wraps` list from the old `passphrase`/`recovery` fields, no
   `verifier` — fall back to a trial decrypt for that case only). Add a v2 **writer**
   gated behind rewrapping on next successful unlock (§3.3's KDF-upgrade path
   naturally handles this once envelope v2 code exists).
3. Song documents: convert padded-string `chords` → anchors on read; keep writing
   anchors only, going forward.
4. Argon2id on the web needs a WASM module (e.g. `hash-wasm`'s argon2id, ~30 KB
   gzipped) since WebCrypto has no built-in Argon2. Until that ships, the web app's
   writer path can keep emitting PBKDF2-600k wraps — Android's reader already
   handles that per the `kdf.name` dispatch in §3 — and switch to Argon2id whenever
   convenient. There's no urgency forcing this to happen before Android Phase 0–5.

None of this blocks Android development. Android targets v2 exclusively from the
start.

---

## 7. Cross-implementation test vectors (mandatory, both repos, before Phase 7)

A fixed set of `(input, expected-output)` pairs, generated once and **committed
verbatim to both repos** under `spec/wire-format-v2/`:

- `kdf-vectors.json` — passphrase + salt + Argon2id params → expected 32-byte KEK
  (hex). Also PBKDF2 vectors for the legacy reader path.
- `envelope-vectors.json` — a full `user_keys.envelope` fixture with a **known
  plaintext DEK**, so both platforms can independently unwrap it and diff.
- `song-vectors.json` — plaintext song documents ↔ their AES-GCM ciphertext under a
  **known DEK + known IV** (IVs are normally random; for these fixed vectors only,
  the IV is pinned so the ciphertext is reproducible and diffable byte-for-byte).
- `chord-anchor-vectors.json` — v1 padded-string ↔ v2 anchor conversions for the
  tricky cases: overlapping chords, a chord past end-of-lyrics, an all-instrumental
  (empty-lyrics) line, adjacent chords with zero gap.
- `recovery-code-vectors.json` — raw pasted input (with stray casing/spacing/no
  hyphens) → normalized form → derived KEK, so both platforms' `normalize()` agree.

**CI in both repos runs these vectors on every change to `src/crypto/` (web) or
`:core:data`'s crypto code (Android).** A failing vector means the platforms have
silently diverged — treat it as a release blocker, not a warning. This is the single
highest-leverage test in either codebase: skip it and the eventual user-visible
failure is "all my songs are gone" on one platform.

---

## Appendix A — v1 format, for migration reference only

Documented here so the migration in §6 has a precise source format to convert from.
**Do not implement anything new against v1** — it exists only in the web app's
current `main` branch and in the `android-port` tag.

- Envelope: PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte salt →
  `{v:1, passphrase:{kdf, wrapped}, recovery:{kdf, wrapped}}`, no `dekId`, no
  `verifier`.
- Song document: `{title, lines, bpm, key, tuning, capo, customChords, createdAt,
  updatedAt}`. `bpm`/`key`/`tuning`/`capo` are strings. `lines[].chords` is a
  space-padded string, column-aligned with `lines[].lyrics`.
- `songs` table: `id, user_id, encrypted, content, title (always null when
  encrypted), is_locked, created_at, updated_at`. No `rev`, no `dek_id`, no
  `deleted_at` — deletes never propagate between devices (a known bug, fixed by
  this document's §1).
