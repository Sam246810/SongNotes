# Sync merge — how two devices' edits to the same song combine

> **This file is committed identically to both repos** (`SongNotes` web and
> `SongNotes-Android`). Change it in both, together.
>
> Wire-level details (field names, row shape, the push protocol) live in
> `WIRE-FORMAT-v2.md`; this doc is the behaviour: what a user sees, why, and what can
> still go wrong.

## Status

| Piece | Web | Android |
|---|---|---|
| Per-line / per-field edit timestamps | done | done |
| Stored base (last server-confirmed version) | done | done (Room v4) |
| Merge engine + shared fixture `spec/song-merge.json` | done | done |
| Conflict copies removed, merge on a lost push | done | done |
| Stale-editor fix | n/a | done |
| Auto-sync on app open/resume | n/a (tabs refresh on focus) | done |
| Split/join-aware merge (rough edges 1–2) | later | later |

Verified: web unit + fixture tests; Android unit + the same fixture; a 300-line
song edited throughout merges in under 50 ms on both; two browsers against the
live backend (different lines, same line different words, same words, delete vs
edit both ways, typing through a merge with the caret staying on its word, a
title/meta race, a custom-chord race); Room v3 -> v4 upgrade on a device with
existing songs; web + Android against the live backend (2026-10-26, Galaxy Z Fold6):
- edits to different lines and different words of one line on each side, with the
  phone's editor open on the stale version: auto-sync on resume merged them, the open
  editor updated in place, and the next phone edit didn't overwrite the web's;
- a delete on the phone vs an edit on the web: the song came back on the phone with
  the edit;
- auto-sync after a force-stop pulled a web rename with no password prompt;
- signing out emptied the stored key and stopped auto-sync, keeping the phone's songs.

## The problem this replaces

Every song row on the server carries a `rev`. A device pushes an edit with
"`WHERE rev = <the rev I started from>`"; if another device pushed first, that check
fails. Until this change, the losing device saved its whole edit as a **new song**
titled `"<title> (conflict copy — <device>, <time>)"` and the user had to compare the
two and merge them by hand.

Problems that behaviour (and the code around it) caused, all fixed by this change:

1. **Conflict copies on any lost race**, on both platforms — web even when the two
   versions were actually identical.
2. **A deleted song came back as a "(conflict copy …)"** if the phone had edited it
   before syncing.
3. **Android stale editor:** the editor loaded a song once; a sync landing while it was
   open was overwritten by the next autosave, and the next push then overwrote the other
   device's edit on the server — silently.
4. **Android lost update during a push:** an edit saved while a push was in flight
   could be marked as synced without ever being sent.
5. **Web:** an edit still waiting to be sent when the tab was reloaded was never sent.
6. **Web:** an edit typed while a conflict was being resolved was dropped.

## When a merge happens

Only when two devices edited the same song before seeing each other's change — the push
that arrives second detects it and merges, then pushes the merged song. Nothing is
merged on the device that pushed first; it picks up the merged result on its next pull.

How often that is depends on how stale a device gets:

- **Web** tabs pull on focus, when the tab is shown, and every 60 s while visible.
- **Android** syncs when the app opens or comes back to the foreground (and on the Sync
  button). A phone that was offline for a while is the common way two edits meet.

## The rules

Each device's version is compared with the **base** — the last version both devices
agreed on (the version the server confirmed before either edit). A device only "changed"
something if it differs from the base.

| What | Only one device changed it | Both changed it, differently |
|---|---|---|
| Title, BPM, key, tuning, capo | that change is kept | the one **edited more recently** (per field) wins |
| A custom chord voicing (per chord name) | kept | the more recently edited voicing wins |
| A line's words | kept | **word-level merge**: both sets of word changes kept; only if both rewrote the *same words* differently → **both versions of the line are kept**, newer first |
| A line's chords | kept | merged per chord position; chords move with the words they sit on; same position changed on both → newer edit of that line wins |
| Adding a line | kept, after the line it followed on that device | both kept; added at the same spot → the earlier-written one first |
| Deleting a line | removed | — |
| Deleted on one, edited on the other | **the edit wins** — the line stays | |
| Deleting the song | deleted | — |
| Song deleted on one, edited on the other | **the edit wins** — the song comes back, with the edit, under its own title | |

"More recently" uses timestamps stored per line and per field, set when the edit was
made on the device — not when it synced. A phone that edits at 9:00 and syncs at 11:00
still counts as 9:00.

Principle behind every rule: **never silently drop text.** When the merge can't tell
what you meant, it keeps both, and the worst case is a doubled line to tidy up.

## Worked examples

Starting song, synced on both devices:

```
Title: Morning Coffee   BPM: 90
L1: The kettle's singing on the stove
L2: Sunlight spilling through the blinds
L3: You hum a song I used to know
```

**1. Rewrite on web, rename on phone**

| Device | Action |
|---|---|
| Web | deletes L1–L3, writes new lines N1–N4, BPM → 100 |
| Phone (offline) | renames to "Sunday Coffee" |

Result: `Sunday Coffee`, BPM 100, lines N1–N4. The phone only changed the title, so the
title is all it affects.

**2. Different lines**

| Device | Action |
|---|---|
| Web | L2 → "Sunlight dancing on the blinds" |
| Phone | L3 → "You hum a song we used to know" |

Result: both edits.

**3. Same line, different words**

| Device | Action |
|---|---|
| Phone | L2 → "Sunlight spilling **across** the blinds" |
| Web | L2 → "Sunlight **dancing** through the blinds" |

Result: `Sunlight dancing across the blinds` — both word changes kept.

**4. Same line, same words changed differently (a true clash)**

| Device | Time | Action |
|---|---|---|
| Phone | 9:00 | L2 → "Sunlight **glowing** through the blinds" |
| Web | 10:00 | L2 → "Sunlight **dancing** through the blinds" |

Result: both lines kept, newer first:

```
L2:  Sunlight dancing through the blinds    ← web, 10:00
L2': Sunlight glowing through the blinds    ← phone, 9:00
```

Delete the one you don't want. If the phone had also renamed the song at 11:00, nothing
changes here: each line and field has its own timestamp, so the rename doesn't make the
phone's older line look newer.

**5. Line deleted on one device, edited on the other**

Web deletes L3; phone fixes a typo in L3 → L3 stays, with the typo fix.

**6. Song deleted on web, edited on phone**

Phone adds a line L4 → the song comes back on both devices with L1–L4 under
"Morning Coffee". No conflict copy.

**7. Lines added, deleted and moved on both devices**

Lines can only be edited, deleted or inserted — moving a line is cut + paste, i.e. a
delete and a new line. Starting from L1–L4:

| Device | Action | That device ends with |
|---|---|---|
| Web | deletes L2; adds W1 after L3; moves L4 to the top (becomes new line W2) | W2, L1, L3, W1 |
| Phone | adds P1 after L1; edits L4 | L1, P1, L2, L3, L4* |

Result: `W2, L1, P1, L3, W1, L4*`. L2 is gone (deleted on web, untouched on phone). L4
appears twice — the web's moved copy (W2) and the phone's edited original (L4*), because
the merge can't know the cut + paste was "the same line moved", and it won't drop the
phone's edit.

## Where the base lives

The merge needs the version both devices started from. It's kept only while a song has
edits not yet confirmed by the server, and dropped once they are.

- **Web:** on the song's row in the browser's local sync cache, still encrypted.
- **Android:** a column on the song's row in the on-device database (which is itself
  encrypted with SQLCipher).

Songs edited before this change have no base. They merge without one: everything both
sides have is kept (lossless, but a deletion on one side can't be told apart from an
addition on the other, so it may come back).

## Rough edges and risks

Known, accepted, and tested:

1. **Joining two lines on one device while the other edits the lower line** → the joined
   line plus the other device's lower line (some text twice). Nothing lost.
2. **Splitting a line (Enter) on one device while the other edits the part after the
   split** → treated as a clash; both versions kept.
3. **Chords inside a rewritten span** snap to the nearest position within the new words.
4. **Device clocks** only matter for true clashes and field-vs-field races; timestamps
   never go backwards on a device, and a clash keeps both lines anyway.
5. **Songs you deleted can come back** if another device had edited them — by design
   (an edit is never thrown away). Delete again if unwanted.
6. **Android: undo history is cleared** when a merge updates the song you're editing, so
   undo can't silently revert the other device's changes.
7. **Rows encrypted with a different key** (e.g. after a key rotation elsewhere) are never
   merged or overwritten; they wait until the key matches.

Mitigated by design (and covered by tests): merge loops between devices (merges are
deterministic and a merge that changes nothing isn't pushed; at most 3 attempts per
sync), typing while a merge lands (rebased, never dropped), very long lines (fall back
to keeping both versions), the two platforms disagreeing (one shared fixture file both
test suites run).

## Android auto-sync and the account key

Auto-sync on open needs the account encryption key without asking for the password every
time. It's stored wrapped by the Android Keystore: bound to this device, usable only
while the phone is unlocked, never backed up, and cleared on sign-out or when sync is
turned off. Tradeoff: anyone using your unlocked phone can sync your songs without the
password — the same boundary that already protects the songs stored on the phone. A
setting ("Keep sync unlocked on this device") turns it off, which brings back the
password prompt on each Sync.

## For developers

- Merge engine: web `src/sync/` (`songMerge.js`, `tokenDiff3.js`, `editStamps.js`);
  Android `core/domain/.../merge/`. Same algorithm, line for line.
- Shared fixture: `spec/song-merge.json`, generated by the web repo —
  `npx vitest run src/test/generate-golden-fixtures.test.js` — and copied
  byte-identical into Android `core/data/src/test/resources/spec/`, where
  `SongMergeGoldenFixtureTest` runs it. Never hand-edit it; change the cases in
  `src/test/fixtures/songMergeCases.js` and regenerate.
- Algorithm details (tokenizer tables, diff3, chord mapping, ordering, tie-breaks):
  `WIRE-FORMAT-v2.md` §5.
