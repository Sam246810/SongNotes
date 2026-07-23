/**
 * In-memory-only key session. The account Data Encryption Key (DEK) and any
 * per-song Content Keys (CK) unlocked with a song password live ONLY here —
 * never in localStorage, IndexedDB, or sent anywhere. Cleared on logout, on
 * explicit lock, or when the tab/module reloads (page refresh = re-enter passphrase).
 */

let dek = null;
const unlockedSongKeys = new Map(); // songId -> CryptoKey, cleared with the rest on lock/logout

export function establishDEK(key) {
  dek = key;
}

export function getDEK() {
  return dek;
}

export function isUnlocked() {
  return dek !== null;
}

export function setUnlockedSongKey(songId, contentKey) {
  unlockedSongKeys.set(songId, contentKey);
}

export function getUnlockedSongKey(songId) {
  return unlockedSongKeys.get(songId) ?? null;
}

export function clearUnlockedSongKey(songId) {
  unlockedSongKeys.delete(songId);
}

/** Wipes the DEK and every unlocked per-song key. Call on logout / explicit lock. */
export function clearSession() {
  dek = null;
  unlockedSongKeys.clear();
}
