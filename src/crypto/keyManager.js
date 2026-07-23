import { bufToBase64, base64ToBuf } from './base64';

/**
 * In-memory-only key session. The account Data Encryption Key (DEK) lives in memory
 * and is cached in sessionStorage to prevent entering the password again when tabbing
 * back or reloading. Cleared on logout or when the tab is closed.
 */

let dek = null;

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

/** Wipes the DEK. Call on logout. */
export function clearSession() {
  dek = null;
  sessionStorage.removeItem('__songnotes_session_dek');
}

/** Restores the DEK from sessionStorage if it exists (e.g. after page refresh) */
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
    return true;
  } catch (e) {
    console.error('Failed to restore session keys', e);
    clearSession();
    return false;
  }
}
