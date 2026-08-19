import { supabase } from '../lib/supabaseClient';
import { SupabaseUserKeysAdapter } from '../lib/userKeysAdapter';
import {
  createAccountKeys,
  unlockWithPassphrase,
  unlockWithRecoveryCode as recoverDekWithCode,
  rewrapWithNewPassphrase,
  regenerateRecoveryWrap,
} from '../crypto/accountKeys';
import { establishDEK, clearSession } from '../crypto/keyManager';
import { CloudSongsRepository, SupabaseSongsAdapter, clearAccountLocalCaches } from '../store/songsRepository';

/**
 * The forgot-password / recovery-code state machine, deliberately kept out of
 * React (no hooks, no context) so it's directly unit-testable — see
 * src/test/accountRecovery.test.js, which is what actually proves the ordering
 * claims made here, not just this file's comments.
 *
 * Every function takes its Supabase-backed collaborators (`authClient`,
 * `keysAdapter`, `songsAdapter`) as optional injected params, defaulting to the
 * real ones — same dependency-injection shape songsRepository.js's
 * CloudSongsRepository already uses (`{ adapter, userId }`) precisely so tests
 * can swap in an in-memory fake instead of mocking the Supabase client's fluent
 * query builder.
 *
 * Two entry points call [recoverWithRecoveryCode]: the reset-password page
 * (arriving from a Supabase recovery email with no DEK at all) and LoginPage's
 * "keyMismatch" flow (already signed in, but the stored envelope doesn't match
 * the just-authenticated password — most likely because it was changed
 * out-of-band). They're the same operation: "I have the recovery code, and I
 * want THIS password to be the one that unlocks the envelope from now on" —
 * `newPassword` just happens to already equal the current one in the second
 * case, which is exactly why step 3 below must treat GoTrue's `same_password`
 * rejection as success rather than an error.
 */

function isSamePasswordError(error) {
  if (!error) return false;
  if (error.code === 'same_password') return true;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('should be different from the old password');
}

/**
 * @returns {Promise<boolean>} whether this account has an envelope at all —
 * used to decide Path A vs Path B up front, rather than after a failed attempt.
 */
export async function hasAccountKeys(userId, { keysAdapter = new SupabaseUserKeysAdapter(supabase, userId) } = {}) {
  return (await keysAdapter.get()) !== null;
}

/**
 * Path A — non-destructive recovery via the recovery code. Ordering is
 * load-bearing, see the plan doc for the full failure-mode table; summary:
 *
 *   1. fetch envelope           — nothing written yet
 *   2. unlock with recovery code — validates the code, still nothing written
 *   3. set the new/current auth password
 *   4. rewrap the envelope for that password
 *   5. establish the DEK for this session
 *
 * A failure at step 4 leaves *State X* (auth password new, envelope still on
 * the old password) — that's exactly the pre-existing `keyMismatch` UI's
 * territory, and it self-heals on a retry because this never touches the
 * recovery wrap. Every earlier failure leaves the server completely untouched.
 *
 * @param {{userId: string, code: string, newPassword: string, authClient?: object, keysAdapter?: object}} args
 * @returns {Promise<{dek: CryptoKey}>}
 */
export async function recoverWithRecoveryCode({
  userId, code, newPassword,
  authClient = supabase.auth,
  keysAdapter = new SupabaseUserKeysAdapter(supabase, userId),
}) {
  const current = await keysAdapter.get();
  if (!current) {
    const err = new Error('No account encryption key found for this account yet — use "start fresh" instead.');
    err.noEnvelope = true;
    throw err;
  }

  // Throws (wrong code / GCM tag failure / verifier mismatch) — nothing written yet.
  const dek = await recoverDekWithCode(current.envelope, code);

  // Required: GoTrue rejects re-submitting the password it already has as
  // "same_password" (422). If updateUser committed but the response was lost,
  // the user's natural retry hits exactly that — without this check the flow
  // would dead-end here forever instead of falling through to the rewrap.
  const { error: pwError } = await authClient.updateUser({ password: newPassword });
  if (pwError && !isSamePasswordError(pwError)) throw pwError;

  const rewrapped = await rewrapWithNewPassphrase(current.envelope, dek, newPassword);
  await keysAdapter.update(rewrapped, current.rev);

  await establishDEK(dek, userId, rewrapped.dekId);
  return { dek };
}

/**
 * Path B — the recovery code is lost, so the DEK is cryptographically
 * unrecoverable. Rotates to a fresh DEK/recovery code and hard-purges every
 * now-unreadable song row. Irreversible; the caller is responsible for a typed
 * confirmation before calling this.
 *
 * `onRecoveryCode` is a BLOCKING callback — the new code must be shown and
 * acknowledged before anything is written server-side. Minting the keys, then
 * writing them, then displaying the code (in that order) is exactly how the
 * old `resetAccountEncryption` ended up discarding codes on a crash or closed
 * tab between steps; gating the write on the callback closes that hole.
 *
 * @param {{userId: string, newPassword: string, onRecoveryCode: (code: string) => Promise<void>|void, authClient?: object, keysAdapter?: object, songsAdapter?: object}} args
 * @returns {Promise<{dek: CryptoKey, recoveryCode: string}>}
 */
export async function rotateAndPurge({
  userId, newPassword, onRecoveryCode,
  authClient = supabase.auth,
  keysAdapter = new SupabaseUserKeysAdapter(supabase, userId),
  songsAdapter = new SupabaseSongsAdapter(supabase, userId),
}) {
  const { error: pwError } = await authClient.updateUser({ password: newPassword });
  if (pwError && !isSamePasswordError(pwError)) throw pwError;

  const { dek, envelope, recoveryCode } = await createAccountKeys(newPassword);

  await onRecoveryCode(recoveryCode);

  const current = await keysAdapter.get();
  if (current) {
    await keysAdapter.update(envelope, current.rev);
  } else {
    await keysAdapter.create(envelope);
  }

  // The old DEK is dead the moment the envelope above lands — drop it before
  // touching anything else so nothing downstream can encrypt under it by mistake.
  // Awaited so the persisted copy in IndexedDB is gone too, not just the in-memory one.
  await clearSession();

  // Reuses CloudSongsRepository purely for its purge logic and its cacheKey math
  // (userId-derived, so it matches the real app repo's localStorage cache entry)
  // — no init(), so it never registers a beforeunload listener.
  const cloudRepo = new CloudSongsRepository({ adapter: songsAdapter, userId });
  cloudRepo.cancelPending();
  await cloudRepo.purgeAll();
  cloudRepo.dispose();

  await establishDEK(dek, userId, envelope.dekId);
  return { dek, recoveryCode };
}

/**
 * Mints a fresh recovery code for an account whose owner never saw/saved
 * theirs, or simply wants to rotate it — requires the DEK already in hand
 * (caller must be unlocked). Does not touch the passphrase wrap, dekId, or
 * verifier, and the DEK itself never changes, so nothing needs re-encrypting.
 * @param {{userId: string, dek: CryptoKey, keysAdapter?: object}} args
 * @returns {Promise<{recoveryCode: string}>}
 */
export async function regenerateRecoveryCode({ userId, dek, keysAdapter = new SupabaseUserKeysAdapter(supabase, userId) }) {
  const current = await keysAdapter.get();
  if (!current) throw new Error('No account encryption key found for this account yet.');
  const { envelope, recoveryCode } = await regenerateRecoveryWrap(current.envelope, dek);
  await keysAdapter.update(envelope, current.rev);
  return { recoveryCode };
}

/**
 * Changes the account password for an already-unlocked session — `updateUser`
 * + `rewrapWithNewPassphrase`, kept atomic the same way `recoverWithRecoveryCode`
 * is (rewrap only after the password change succeeds). Closes the same envelope-
 * desync hole a user would otherwise hit by changing their password directly
 * without anything rewrapping the envelope for it.
 * @param {{userId: string, dek: CryptoKey, newPassword: string, authClient?: object, keysAdapter?: object}} args
 */
export async function changePassword({
  userId, dek, newPassword,
  authClient = supabase.auth,
  keysAdapter = new SupabaseUserKeysAdapter(supabase, userId),
}) {
  const current = await keysAdapter.get();
  if (!current) throw new Error('No account encryption key found for this account yet.');

  const { error: pwError } = await authClient.updateUser({ password: newPassword });
  if (pwError && !isSamePasswordError(pwError)) throw pwError;

  const rewrapped = await rewrapWithNewPassphrase(current.envelope, dek, newPassword);
  await keysAdapter.update(rewrapped, current.rev);
}

/**
 * Permanently deletes the signed-in user's account and everything that
 * references it. Irreversible; the caller is responsible for a typed
 * confirmation before calling this, same contract as rotateAndPurge.
 *
 * The actual delete happens server-side via the `delete_own_account` Postgres
 * RPC (see supabase/schema.sql) rather than a client-side DELETE, because
 * removing the auth.users row itself needs privilege the authenticated role
 * doesn't have directly. That function is scoped to auth.uid(), and every
 * user_keys / user_keys_history / songs row cascades from auth.users, so one
 * RPC call is the entire deletion — nothing else needs purging here.
 *
 * @param {{authClient?: object, rpc?: (fn: string) => Promise<{error: any}>}} [args]
 */
export async function deleteAccount({
  authClient = supabase.auth,
  rpc = (fn) => supabase.rpc(fn),
} = {}) {
  const { error } = await rpc('delete_own_account');
  if (error) throw error;

  await clearSession();
  // The server side of deletion is complete at this point (every user_keys,
  // user_keys_history and songs row cascades from auth.users), but the DEVICE still
  // held this account's cached ciphertext rows and migration flags — nothing in the
  // codebase ever removed them. A user who asked for deletion should not be left with
  // their song count, row ids and timestamps sitting in localStorage afterwards.
  clearAccountLocalCaches();
  // Best-effort: the account is already gone server-side at this point, so
  // signOut's only remaining job is clearing Supabase's local-storage copy of
  // the now-invalid session — a failure here doesn't leave anything undeleted.
  try {
    await authClient.signOut();
  } catch (e) {
    console.error('Failed to clear local session after account deletion', e);
  }
}

export { unlockWithPassphrase };
