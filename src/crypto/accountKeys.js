import {
  generateSalt, deriveKEK, serializeKdfParams, deserializeKdfParams,
  DEFAULT_KDF_PARAMS, isBelowCurrentKdfPolicy,
} from './kdf';
import {
  generateContentKey, wrapContentKey, unwrapContentKey,
  computeDekVerifier, checkDekVerifier,
} from './envelope';

/**
 * Account-level key envelope: a single random Data Encryption Key (DEK) per user,
 * wrapped once per unlock method ("wraps") -- passphrase and recovery code today,
 * a per-device Keystore wrap from the Android client in the future -- so any one
 * of them independently unlocks it. This whole envelope is what gets stored
 * server-side in `user_keys.envelope`; the DEK itself never is.
 *
 * v2 (current): `wraps` is a list, not fixed `passphrase`/`recovery` fields, so a
 * new unlock method (e.g. an Android device wrap) is just another list entry, not
 * a schema change. Adds `dekId` (also meant to be stamped on encrypted rows once
 * the data layer carries it, so "encrypted under a previous key" is identifiable
 * instead of just "decrypt threw") and a `verifier` -- see envelope.js's
 * `computeDekVerifier` -- so a wrong passphrase/code is a clean, obvious failure.
 * New wraps are always Argon2id (see kdf.js); PBKDF2 wraps only exist in v1
 * envelopes still on disk, and get rewrapped to Argon2id the next time they
 * successfully unlock (`migrateWrapIfNeeded`).
 *
 * v1 envelopes (`{v:1, passphrase:{kdf,wrapped}, recovery:{kdf,wrapped}}`) are
 * still readable by `unlockWithPassphrase`/`unlockWithRecoveryCode` below --
 * accounts created before this change must keep working -- but nothing writes v1
 * anymore.
 */
const ENVELOPE_VERSION = 2;

/**
 * @param {string} accountPassword
 * @param {string} [recoveryCode]
 * @returns {Promise<{dek: CryptoKey, envelope: object, recoveryCode: string}>}
 */
export async function createAccountKeys(accountPassword, recoveryCode = generateRecoveryCode()) {
  const dek = await generateContentKey();
  const envelope = await buildEnvelopeV2(dek, accountPassword, recoveryCode);
  return { dek, envelope, recoveryCode };
}

async function buildEnvelopeV2(dek, accountPassword, recoveryCode) {
  const passWrap = await buildWrap('pass', 'passphrase', accountPassword, dek);
  const recoveryWrap = await buildWrap('recovery', 'recovery-code', recoveryCode, dek);
  const verifier = await computeDekVerifier(dek);
  return {
    v: ENVELOPE_VERSION,
    dekId: generateDekId(),
    alg: 'AES-256-GCM',
    wraps: [passWrap, recoveryWrap],
    verifier,
  };
}

async function buildWrap(id, type, secret, dek) {
  const salt = generateSalt();
  const kek = await deriveKEK(secret, salt);
  const { iv, wrapped: ct } = await wrapContentKey(kek, dek);
  return { id, type, kdf: serializeKdfParams(salt), iv, ct };
}

/** A high-entropy, easy-to-transcribe recovery code (unambiguous alphabet, grouped). */
export function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20)); // 160 bits of entropy
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes 0/O, 1/I/L etc.
  let code = '';
  for (let i = 0; i < bytes.length; i++) {
    code += alphabet[bytes[i] % alphabet.length];
    if ((i + 1) % 5 === 0 && i !== bytes.length - 1) code += '-';
  }
  return code;
}

/** A short random identifier stamped on the envelope (and, later, on encrypted rows). */
function generateDekId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** @returns {Promise<CryptoKey>} the DEK, or throws if the account password is wrong. */
export async function unlockWithPassphrase(envelope, accountPassword) {
  return unlockWithType(envelope, 'passphrase', 'passphrase', accountPassword);
}

/** Alias for unlockWithPassphrase */
export const unlockWithAccountPassword = unlockWithPassphrase;

/** @returns {Promise<CryptoKey>} the DEK, or throws if the recovery code is wrong. */
export async function unlockWithRecoveryCode(envelope, recoveryCode) {
  return unlockWithType(envelope, 'recovery', 'recovery-code', recoveryCode);
}

async function unlockWithType(envelope, v1Field, v2Type, secret) {
  const wrap = findWrap(envelope, v1Field, v2Type);
  const { salt, ...kdfParams } = deserializeKdfParams(wrap.kdf);
  const kek = await deriveKEK(secret, salt, kdfParams);
  const dek = await unwrapContentKey(kek, wrapToLegacyShape(wrap));
  if (envelope.v >= 2 && !(await checkDekVerifier(dek, envelope.verifier))) {
    // Correct KDF inputs unwrapped *a* key (GCM tag matched), but it isn't the DEK
    // this envelope's verifier was computed for -- shouldn't happen outside a bug
    // or a tampered envelope, but fail loudly rather than silently trusting it.
    throw new Error('DEK verifier mismatch after unwrap');
  }
  return dek;
}

/**
 * Finds a v2 `wraps[]` entry by type, or synthesizes a full wrap-shaped object (with
 * `id`/`type` set, same as a real v2 entry) from a v1 envelope's fixed fields -- so
 * a v1-derived wrap can be dropped straight into a new envelope's `wraps[]` (see
 * `rewrapWithNewPassphrase`'s upgrade path) without special-casing it there.
 */
function findWrap(envelope, v1Field, v2Type) {
  if (envelope.v >= 2) {
    const wrap = envelope.wraps.find((w) => w.type === v2Type);
    if (!wrap) throw new Error(`No "${v2Type}" wrap in this envelope`);
    return wrap;
  }
  const legacy = envelope[v1Field];
  if (!legacy) throw new Error(`No "${v1Field}" entry in this v1 envelope`);
  return {
    id: v1Field === 'passphrase' ? 'pass' : 'recovery',
    type: v2Type,
    kdf: legacy.kdf,
    iv: legacy.wrapped.iv,
    ct: legacy.wrapped.wrapped,
  };
}

/** unwrapContentKey expects envelope.js's `{iv, wrapped}` shape; wraps[] stores `{iv, ct}`. */
function wrapToLegacyShape(wrap) {
  return { iv: wrap.iv, wrapped: wrap.ct };
}

/**
 * After recovering the DEK via the recovery code, set a new account password for it.
 * Always emits a v2 envelope (a v1 envelope passed in is upgraded as a side effect).
 */
export async function rewrapWithNewPassphrase(envelope, dek, newAccountPassword) {
  const passWrap = await buildWrap('pass', 'passphrase', newAccountPassword, dek);
  if (envelope.v >= 2) {
    return {
      ...envelope,
      wraps: envelope.wraps.map((w) => (w.type === 'passphrase' ? passWrap : w)),
    };
  }
  // Upgrading a v1 envelope: keep its existing recovery wrap (still v1-shaped;
  // migrateWrapIfNeeded will bring it to Argon2id on its own next successful unlock).
  const recoveryLegacy = findWrap(envelope, 'recovery', 'recovery-code');
  return {
    v: ENVELOPE_VERSION,
    dekId: generateDekId(),
    alg: 'AES-256-GCM',
    wraps: [passWrap, recoveryLegacy],
    verifier: await computeDekVerifier(dek),
  };
}

/**
 * Re-wraps a single unlock method (passphrase or recovery code) with the current
 * KDF policy (Argon2id) if it was still on PBKDF2 -- called with the secret + DEK
 * already in hand from a *successful* unlock, so this never prompts for anything
 * extra. Returns the envelope unchanged if nothing needed migrating.
 *
 * Only handles v2 envelopes whose wrap is still PBKDF2 -- a v1 envelope entirely
 * is upgraded to v2 the next time its owner changes their password or resets via
 * recovery code (both already produce a v2 envelope, see `rewrapWithNewPassphrase`
 * above), not silently on every unlock.
 * @returns {Promise<{envelope: object, migrated: boolean}>}
 */
export async function migrateWrapIfNeeded(envelope, v2Type, secret, dek) {
  if (envelope.v < 2) return { envelope, migrated: false };
  const wrap = envelope.wraps.find((w) => w.type === v2Type);
  if (!wrap || !isBelowCurrentKdfPolicy(wrap.kdf)) return { envelope, migrated: false };

  const newWrap = await buildWrap(wrap.id, v2Type, secret, dek);
  return {
    envelope: { ...envelope, wraps: envelope.wraps.map((w) => (w.type === v2Type ? newWrap : w)) },
    migrated: true,
  };
}

export { DEFAULT_KDF_PARAMS };
