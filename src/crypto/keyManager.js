/**
 * In-memory key session, with a **non-extractable** copy persisted to IndexedDB so a
 * reload doesn't re-prompt for the account password.
 *
 * Why not sessionStorage: this used to `crypto.subtle.exportKey('raw', dek)` and write
 * the account's master key to sessionStorage as base64. That turned a key the browser
 * would otherwise hold opaquely into a string any script on the origin could lift with
 * a single `getItem` — and since the Supabase refresh token lives in localStorage right
 * beside it, one XSS yielded both persistent account access and the ability to decrypt
 * every song. In a zero-knowledge product that is the whole ballgame, so the persisted
 * form is now a `CryptoKey` object with `extractable: false`, stored in IndexedDB
 * (CryptoKey is structured-cloneable, so this round-trips intact). An attacker with
 * script execution can still *use* that key while the tab is open; they can no longer
 * exfiltrate it, which turns a total, permanent key compromise into a session-scoped one.
 *
 * Two DEK handles, deliberately:
 *
 *   getDEK()          — the working key for song encrypt/decrypt. Always present while
 *                       unlocked. After a reload this is the non-extractable copy.
 *   getWrappableDEK() — the extractable key, held in memory ONLY and never persisted.
 *                       Null after a reload.
 *
 * The split exists because WebCrypto's `wrapKey` refuses a non-extractable key, and
 * rewrapping the envelope (change password, regenerate recovery code) has to wrap the
 * DEK. Those flows therefore need `getWrappableDEK()`, and when it's null the caller
 * re-prompts for the password (AccountPage already has that gate). Re-authenticating
 * before changing a password is good practice independently, so this costs nothing.
 *
 * Storage is namespaced per user id — otherwise switching accounts in one tab (sign out
 * of A, sign into B) could import a DEK a crashed session left behind for A and silently
 * decrypt-fail into placeholders under B. clearSession() sweeps every user's entry, not
 * just the active one, as a second line of defense.
 *
 * Also tracks which envelope `dekId` the current DEK came from (see accountKeys.js's
 * `generateDekId`) — not secret, just an identifier, but it's what lets
 * songsRepository.js stamp `songs.dek_id` on every write and tell "encrypted under a
 * previous key" (a DEK rotation happened) apart from a genuinely corrupt row before ever
 * attempting a decrypt that's guaranteed to fail.
 */

const DB_NAME = '__songnotes_keys';
const DB_VERSION = 1;
const STORE = 'deks';

/** Legacy sessionStorage prefixes — read once to migrate, then purged. See migrateLegacy(). */
const LEGACY_DEK_PREFIX = '__songnotes_session_dek:';
const LEGACY_DEK_ID_PREFIX = '__songnotes_session_dek_id:';

let dek = null;           // working key (encrypt/decrypt); extractable pre-reload, not after
let wrappableDek = null;  // extractable key, memory only, never persisted
let dekId = null;
let activeUserId = null;

/* ------------------------------------------------------------------ IndexedDB glue */

function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest(mode, fn) {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    }, reject);
  });
}

const idbGet = (key) => idbRequest('readonly', (s) => s.get(key));
const idbPut = (value, key) => idbRequest('readwrite', (s) => s.put(value, key));
const idbClearAll = () => idbRequest('readwrite', (s) => s.clear());

/* ------------------------------------------------------------------ key helpers */

/**
 * Re-imports `key` as a NON-EXTRACTABLE AES-GCM key limited to encrypt/decrypt — the
 * form that gets persisted. Requires `key` itself to be extractable (it always is at
 * this point: it was either just generated or just unwrapped from the envelope).
 */
async function toNonExtractable(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    // Best-effort scrub of the transient plaintext key bytes.
    new Uint8Array(raw).fill(0);
  }
}

/**
 * One-time migration off the old sessionStorage format: import the legacy raw key as a
 * non-extractable CryptoKey, persist that, then delete the legacy entry. Users mid-session
 * during a deploy keep their session instead of being bounced to a password prompt, and
 * the plaintext copy is gone by the time this returns.
 */
async function migrateLegacy(userId) {
  let stored = null;
  try {
    stored = sessionStorage.getItem(LEGACY_DEK_PREFIX + userId);
  } catch { return null; }
  if (!stored) return null;

  try {
    const binary = atob(stored);
    const rawDek = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) rawDek[i] = binary.charCodeAt(i);
    const key = await crypto.subtle.importKey('raw', rawDek, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    rawDek.fill(0);
    const legacyDekId = sessionStorage.getItem(LEGACY_DEK_ID_PREFIX + userId) || null;
    if (idbAvailable()) {
      try { await idbPut({ key, dekId: legacyDekId }, userId); } catch { /* fall through; in-memory still works */ }
    }
    return { key, dekId: legacyDekId };
  } catch (e) {
    console.error('Failed to migrate legacy session key', e);
    return null;
  } finally {
    clearLegacyStorage();
  }
}

function clearLegacyStorage() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key && (key.startsWith(LEGACY_DEK_PREFIX) || key.startsWith(LEGACY_DEK_ID_PREFIX))) {
        sessionStorage.removeItem(key);
      }
    }
  } catch { /* sessionStorage unavailable; nothing to clear */ }
}

/* ------------------------------------------------------------------ public API */

/**
 * @param {CryptoKey|null} key the freshly generated or unwrapped (extractable) DEK.
 * @param {string} [userId] required (alongside a truthy `key`) to persist across reloads.
 *   Omitted, this only sets the in-memory DEK for the current tab — still useful for
 *   tests and short-lived verification steps.
 * @param {string} [dekIdValue] the envelope's `dekId` this key came from — see
 *   accountKeys.js. Optional for the same reason `userId` is; `getActiveDekId()` simply
 *   returns null if it was never provided.
 * @returns {Promise<void>} resolves once persistence has completed (or failed and been
 *   logged) — callers that navigate immediately after should await this rather than
 *   firing it and moving on, which used to race a reload.
 */
export async function establishDEK(key, userId, dekIdValue) {
  dek = key;
  wrappableDek = key;
  activeUserId = key ? (userId ?? null) : null;
  dekId = key ? (dekIdValue ?? null) : null;

  if (!key) {
    await clearPersisted();
    return;
  }
  if (!userId) return; // in-memory only — no persistence, no non-extractable copy

  clearLegacyStorage(); // never leave a plaintext copy behind once we own this session
  if (!idbAvailable()) return; // e.g. jsdom under test — in-memory session still works

  try {
    const persistable = await toNonExtractable(key);
    await idbPut({ key: persistable, dekId: dekIdValue ?? null }, userId);
  } catch (err) {
    console.error('Failed to persist DEK for session restore', err);
  }
}

/** The working key for song encrypt/decrypt. Non-extractable after a reload. */
export function getDEK() {
  return dek;
}

/**
 * The extractable DEK, for envelope rewrapping only (`crypto.subtle.wrapKey` rejects a
 * non-extractable key). Null after a page reload — callers must then re-prompt for the
 * account password to unlock a fresh one rather than assuming a restored session can
 * rewrap. Never persisted anywhere.
 * @returns {CryptoKey|null}
 */
export function getWrappableDEK() {
  return wrappableDek;
}

/** @returns {string|null} the envelope dekId the current DEK was established from, if known. */
export function getActiveDekId() {
  return dekId;
}

export function isUnlocked() {
  return dek !== null;
}

async function clearPersisted() {
  clearLegacyStorage();
  if (!idbAvailable()) return;
  try { await idbClearAll(); } catch { /* nothing usable to clear */ }
}

/**
 * Wipes the DEK — in memory, in IndexedDB, and any legacy sessionStorage copy. Call on
 * logout and on account deletion.
 * @returns {Promise<void>} resolves once the persisted copies are gone. Synchronous
 *   callers that don't await still get the in-memory wipe immediately.
 */
export function clearSession() {
  dek = null;
  wrappableDek = null;
  dekId = null;
  activeUserId = null;
  return clearPersisted();
}

/**
 * Restores the DEK from IndexedDB if one exists for `userId` (e.g. after a page refresh),
 * falling back to a one-time migration of the legacy sessionStorage format. No-ops
 * (returns true) if the in-memory DEK already belongs to this same user.
 *
 * A restored DEK is non-extractable, so `getWrappableDEK()` stays null afterwards.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function restoreSession(userId) {
  if (dek && activeUserId === userId) return true;
  if (!userId) return false;

  let entry = null;
  if (idbAvailable()) {
    try { entry = await idbGet(userId); } catch (e) { console.error('Failed to read stored session key', e); }
  }
  if (!entry) entry = await migrateLegacy(userId);
  if (!entry?.key) return false;

  dek = entry.key;
  wrappableDek = null; // restored keys are non-extractable; rewrap flows must re-unlock
  activeUserId = userId;
  dekId = entry.dekId ?? null;
  return true;
}
