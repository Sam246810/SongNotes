const PENDING_KEY = '__songnotes_pending_encrypt_intent';

/**
 * Single-use "what the guest was trying to do when we told them to sign in"
 * descriptor, carried across the /login or /signup navigation via sessionStorage
 * (survives the page load; cleared on first read). Two shapes:
 *
 *   { mode: 'new', title }                 - EncryptChoiceDialog, before a song exists
 *   { mode: 'existing', song }              - Toolbar's password-protect warning, on an
 *                                              already-created (possibly guest-local) song
 *
 * In both cases the intent is "encrypted: true" — App.jsx applies it once signed in.
 */

export function savePendingSongIntent(intent) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent));
    // Skip the book-cover landing screen on return, so the redirect lands the user
    // straight back in the app rather than behind an extra click.
    sessionStorage.setItem('songnotes_book_opened', 'true');
  } catch (e) {
    console.error('SongNotes: failed to save pending song intent', e);
  }
}

/** Peek without consuming — used to decide whether to skip the book-cover landing screen. */
export function hasPendingSongIntent() {
  return Boolean(sessionStorage.getItem(PENDING_KEY));
}

export function takePendingSongIntent() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw);
  } catch (e) {
    console.error('SongNotes: failed to read pending song intent', e);
    sessionStorage.removeItem(PENDING_KEY);
    return null;
  }
}
