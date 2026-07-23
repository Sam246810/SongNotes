import { bufToBase64, base64ToBuf } from './base64';

/**
 * In-memory-only key session. The account Data Encryption Key (DEK) and any
 * per-song Content Keys (CK) unlocked with a song password live in memory and are cached
 * in sessionStorage to prevent entering the passphrase again when tabbing back or reloading.
 * Cleared on logout, on explicit lock/relock, or when the tab is closed.
 */

let dek = null;
const unlockedSongKeys = new Map(); // songId -> CryptoKey

export function establishDEK(key) {
  dek = key;
  if (key) {
    crypto.subtle.exportKey('raw', key)
      .then((raw) => {
        sessionStorage.setItem('__songnotes_session_dek', bufToBase64(new Uint8Array(raw)));
      })
      .catch((err) => console.error('Failed to export DEK for session storage', err));
  } else {
    sessionStorage.removeItem('__songnotes_session_dek');
  }
}

export function getDEK() {
  return dek;
}

export function isUnlocked() {
  return dek !== null;
}

export function setUnlockedSongKey(songId, contentKey) {
  unlockedSongKeys.set(songId, contentKey);
  if (contentKey) {
    crypto.subtle.exportKey('raw', contentKey)
      .then((raw) => {
        try {
          const keysObj = JSON.parse(sessionStorage.getItem('__songnotes_session_song_keys') || '{}');
          keysObj[songId] = bufToBase64(new Uint8Array(raw));
          sessionStorage.setItem('__songnotes_session_song_keys', JSON.stringify(keysObj));
        } catch (e) {
          console.error(e);
        }
      })
      .catch((err) => console.error('Failed to export song key for session storage', err));
  }
}

export function getUnlockedSongKey(songId) {
  return unlockedSongKeys.get(songId) ?? null;
}

export function clearUnlockedSongKey(songId) {
  unlockedSongKeys.delete(songId);
  try {
    const keysObj = JSON.parse(sessionStorage.getItem('__songnotes_session_song_keys') || '{}');
    delete keysObj[songId];
    sessionStorage.setItem('__songnotes_session_song_keys', JSON.stringify(keysObj));
  } catch (e) {}
}

/** Wipes the DEK and every unlocked per-song key. Call on logout / explicit lock. */
export function clearSession() {
  dek = null;
  unlockedSongKeys.clear();
  sessionStorage.removeItem('__songnotes_session_dek');
  sessionStorage.removeItem('__songnotes_session_song_keys');
}

/** Restores DEK and song keys from sessionStorage if they exist (e.g. after page refresh) */
export async function restoreSession() {
  if (dek) return true;
  const storedDek = sessionStorage.getItem('__songnotes_session_dek');
  if (!storedDek) return false;
  try {
    const rawDek = base64ToBuf(storedDek);
    dek = await crypto.subtle.importKey(
      'raw',
      rawDek,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    );

    const storedSongKeys = sessionStorage.getItem('__songnotes_session_song_keys');
    if (storedSongKeys) {
      const keysObj = JSON.parse(storedSongKeys);
      for (const [songId, base64Key] of Object.entries(keysObj)) {
        const rawKey = base64ToBuf(base64Key);
        const importedKey = await crypto.subtle.importKey(
          'raw',
          rawKey,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
        );
        unlockedSongKeys.set(songId, importedKey);
      }
    }
    return true;
  } catch (e) {
    console.error('Failed to restore session keys', e);
    clearSession();
    return false;
  }
}
