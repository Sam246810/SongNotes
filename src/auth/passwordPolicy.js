/**
 * Account password policy.
 *
 * In a zero-knowledge product the account password is not merely a login credential —
 * it is a cryptographic parameter. The server holds `user_keys.envelope`, which contains
 * the account DEK wrapped by a KEK derived straight from this password (see
 * src/crypto/accountKeys.js). Anyone who obtains a copy of that table — a database
 * compromise, a leaked backup, a misissued service_role key — can attack the wrap
 * offline, with no rate limiting and unlimited attempts.
 *
 * That makes password length the real floor under the whole "unreadable even to someone
 * with full database access" claim. The previous minimum was 6 characters (Supabase's
 * default), which is roughly 28 bits for a lowercase password. Argon2id at 64 MiB makes
 * each guess genuinely expensive and is the right choice, but it cannot rescue a keyspace
 * that small from an attacker willing to rent GPUs. The recovery code is ~100 bits and
 * was never the weak link; this was.
 *
 * ── Enforcement, and its limits ──────────────────────────────────────────────────────
 * This module is CLIENT-side and therefore advisory: anyone can bypass it by calling the
 * API directly. It exists to steer real users, not to stop attackers. The binding control
 * is the server-side minimum in the Supabase dashboard (Authentication → Providers →
 * minimum password length), which must be raised separately — see docs/DEPLOYMENT.md.
 *
 * ── Why this does not break the Android client ───────────────────────────────────────
 * Sign-IN never checks length (LoginPage deliberately has no minLength), so every
 * existing account — including any created on Android with a 6-character password —
 * keeps working everywhere. This only applies when a password is being *set*. Raising the
 * server-side minimum would additionally affect Android signup and password-change, which
 * is why that step is called out as a deliberate decision rather than done silently.
 */

/** Minimum length for a newly set account password. */
export const MIN_PASSWORD_LENGTH = 12;

/** Shown under password fields so the requirement reads as a reason, not a rule. */
export const PASSWORD_HELP_TEXT =
  `At least ${MIN_PASSWORD_LENGTH} characters. This password encrypts your songs — ` +
  'a longer passphrase of a few words is both stronger and easier to remember.';

/**
 * @param {string} password
 * @returns {string|null} an error message, or null if acceptable.
 */
export function validateNewPassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
