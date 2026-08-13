import { bufToBase64, base64ToBuf } from './base64';

/**
 * In-memory-only key session. The account Data Encryption Key (DEK) lives in memory
 * and is cached in sessionStorage to prevent entering the password again when tabbing
 * back or reloading. Cleared on logout or when the tab is closed.
 *
 * The sessionStorage key is namespaced per user id (`__songnotes_session_dek:<id>`,
 * previously a single fixed key shared by every account) — otherwise switching
 * accounts in the same tab (sign out of A, sign into B) could import a DEK a
 * crashed/closed session left behind for A and silently decrypt-fail into
 * placeholders under B instead of just... not being there. clearSession() sweeps
 * every matching key, not only the active user's, as a second line of defense.
 *
 * Also tracks which envelope `dekId` the current DEK came from (see
 * accountKeys.js's `generateDekId`) — not secret, just an identifier, but it's
 * what lets songsRepository.js stamp `songs.dek_id` on every write and tell
 * "encrypted under a previous key" (a DEK rotation happened) apart from a
 * genuinely corrupt row before ever attempting a decrypt that's guaranteed to fail.
 */

const DEK_STORAGE_PREFIX = '__songnotes_session_dek:';
const DEK_ID_STORAGE_PREFIX = '__songnotes_session_dek_id:';

let dek = null;
let dekId = null;
let activeUserId = null;

/**
 * @param {CryptoKey|null} key
 * @param {string} [userId] required (alongside a truthy `key`) to persist to
 *   sessionStorage — omitted, this only sets the in-memory DEK for the duration
 *   of the current tab (still useful for tests/short-lived flows).
 * @param {string} [dekIdValue] the envelope's `dekId` this key came from — see
 *   accountKeys.js. Optional for the same reason `userId` is; `getActiveDekId()`
 *   simply returns null if it was never provided.
 * @returns {Promise<void>} resolves once the sessionStorage write has completed
 *   (or failed and been logged) — callers that navigate immediately after should
 *   await this rather than firing it and moving on, which used to race a reload.
 */
export async function establishDEK(key, userId, dekIdValue) {
  dek = key;
  activeUserId = key ? (userId ?? null) : null;
  dekId = key ? (dekIdValue ?? null) : null;
  if (!key) {
    clearAllStoredDeks();
    return;
  }
  if (!userId) return; // in-memory only, e.g. a short-lived verification step
  try {
    const raw = await crypto.subtle.exportKey('raw', key);
    sessionStorage.setItem(DEK_STORAGE_PREFIX + userId, bufToBase64(new Uint8Array(raw)));
    if (dekIdValue) sessionStorage.setItem(DEK_ID_STORAGE_PREFIX + userId, dekIdValue);
    else sessionStorage.removeItem(DEK_ID_STORAGE_PREFIX + userId);
  } catch (err) {
    console.error('Failed to export DEK for session storage', err);
  }
}

export function getDEK() {
  return dek;
}

/** @returns {string|null} the envelope dekId the current DEK was established from, if known. */
export function getActiveDekId() {
  return dekId;
}

export function isUnlocked() {
  return dek !== null;
}

function clearAllStoredDeks() {
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i);
    if (key && (key.startsWith(DEK_STORAGE_PREFIX) || key.startsWith(DEK_ID_STORAGE_PREFIX))) {
      sessionStorage.removeItem(key);
    }
  }
}

/** Wipes the DEK (in memory and every cached copy in sessionStorage). Call on logout. */
export function clearSession() {
  dek = null;
  dekId = null;
  activeUserId = null;
  clearAllStoredDeks();
}

/**
 * Restores the DEK from sessionStorage if it exists for `userId` (e.g. after a
 * page refresh). No-ops (returns true) if the in-memory DEK already belongs to
 * this same user.
 * @param {string} userId
 */
export async function restoreSession(userId) {
  if (dek && activeUserId === userId) return true;
  const stored = userId ? sessionStorage.getItem(DEK_STORAGE_PREFIX + userId) : null;
  if (!stored) return false;
  try {
    const rawDek = base64ToBuf(stored);
    dek = await crypto.subtle.importKey(
      'raw',
      rawDek,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    );
    activeUserId = userId;
    dekId = sessionStorage.getItem(DEK_ID_STORAGE_PREFIX + userId) || null;
    return true;
  } catch (e) {
    console.error('Failed to restore session keys', e);
    clearSession();
    return false;
  }
}
