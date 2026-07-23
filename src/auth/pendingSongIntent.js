const PENDING_KEY = '__songnotes_pending_encrypt_intent';
// Stale intents older than this are ignored and cleared rather than resurrected —
// guards against a long-abandoned attempt firing on some unrelated future sign-in.
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Single-use "what the guest was trying to do when we told them to sign in"
 * descriptor, carried across the /login or /signup navigation. Two shapes:
 *
 *   { mode: 'new', title }                 - EncryptChoiceDialog, before a song exists
 *   { mode: 'existing', song }              - Toolbar's password-protect warning, on an
 *                                              already-created (possibly guest-local) song
 *
 * In both cases the intent is "encrypted: true" — App.jsx applies it once signed in.
 *
 * Stored in localStorage, NOT sessionStorage: signing up requires confirming by email,
 * and that confirmation link almost always opens in a brand-new browser tab/window —
 * which has its own separate sessionStorage and would never see an intent saved there.
 * localStorage is shared across every tab of the same browser, so it survives that hop.
 *
 * Deliberately peek-then-clear rather than take-once: fulfilling the intent can fail
 * (most notably, the account DEK isn't established yet — see App.jsx) in which case the
 * intent must survive so it can be retried, instead of being silently discarded.
 */

export function savePendingSongIntent(intent) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ ...intent, savedAt: Date.now() }));
  } catch (e) {
    console.error('SongNotes: failed to save pending song intent', e);
  }
}

/** Peek without consuming — also used to decide whether to skip the book-cover screen. */
export function peekPendingSongIntent() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const { savedAt, ...intent } = JSON.parse(raw);
    if (!savedAt || Date.now() - savedAt > MAX_AGE_MS) {
      localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return intent;
  } catch (e) {
    console.error('SongNotes: failed to read pending song intent', e);
    localStorage.removeItem(PENDING_KEY);
    return null;
  }
}

export function hasPendingSongIntent() {
  return Boolean(peekPendingSongIntent());
}

/** Call only once the intent has actually been fulfilled successfully. */
export function clearPendingSongIntent() {
  localStorage.removeItem(PENDING_KEY);
}
