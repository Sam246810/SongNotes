/**
 * Recovery-code normalization — the wire contract shared with Android (see
 * docs/WIRE-FORMAT-v2.md §3.1). A recovery code is a KDF input, not just display
 * text: the exact string typed by the user is what gets Argon2id-derived into a
 * KEK, so "the same code" retyped lowercase, without hyphens, or with stray
 * whitespace must still derive the identical key on both platforms.
 *
 * `normalizeRecoveryCode` is deliberately total (never throws) and dumb — no
 * length check, no confusable-character correction — so it stays safe to run on
 * every unlock attempt, correct or not, and so the committed golden fixtures
 * (spec/recovery-code-vectors.json) fully pin its behavior across both languages.
 * UI-facing hints belong in `describeRecoveryCodeInput` below, not here.
 */

/**
 * Same alphabet as generateRecoveryCode (accountKeys.js) — excludes 0, 1, I, O
 * (not L: the string reads ...GHJKLMN..., L is a valid, generatable character).
 */
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ALPHABET_SET = new Set(RECOVERY_CODE_ALPHABET.split(''));

/**
 * Canonicalizes user-entered recovery-code text before it's used as a KDF input:
 * NFKC-normalize (folds full-width/compatibility variants like 'Ａ' to 'A'),
 * uppercase (locale-invariant — critical in Kotlin, where the deprecated
 * `toUpperCase()` is Turkish-locale-sensitive; use `uppercase()`), strip every
 * character not in the alphabet (drops hyphens, whitespace, anything else), then
 * regroup into 5-character chunks joined by '-' with NO trailing separator.
 *
 * Idempotent and a no-op on any canonically-generated code, so this can never
 * break a code that currently works: `normalize(generateRecoveryCode()) ===
 * generateRecoveryCode()`.
 * @param {string} input
 * @returns {string}
 */
export function normalizeRecoveryCode(input) {
  if (!input) return '';
  const stripped = input
    .normalize('NFKC')
    .toUpperCase()
    .split('')
    .filter((ch) => ALPHABET_SET.has(ch))
    .join('');
  if (!stripped) return '';
  // chunk into groups of 5, no trailing separator on a full-multiple-of-5 input
  return stripped.match(/.{1,5}/g).join('-');
}

/**
 * UI-only diagnostics for a not-yet-submitted recovery-code input — never used on
 * the derive path, so it can carry opinions (expected length, confusable chars)
 * that normalizeRecoveryCode deliberately doesn't. Meant to warn *before* an
 * ~1s Argon2id attempt, not to block one.
 * @param {string} input
 * @returns {{normalized: string, normalizedLength: number, confusables: string[]}}
 */
export function describeRecoveryCodeInput(input) {
  const normalized = normalizeRecoveryCode(input);
  const upper = (input || '').normalize('NFKC').toUpperCase();
  // Only characters actually absent from the alphabet -- L is NOT one of them.
  const confusables = Array.from(new Set(upper.split(''))).filter((ch) =>
    ['I', 'O', '0', '1'].includes(ch)
  );
  return { normalized, normalizedLength: normalized.replace(/-/g, '').length, confusables };
}
