import { argon2id } from 'hash-wasm';
import { bufToBase64, base64ToBuf } from './base64';

/**
 * Key derivation — turns a human passphrase (account passphrase, recovery code, or
 * per-song password) into an AES-GCM key-encryption-key (KEK), never persisted.
 *
 * Argon2id (m=64 MiB, t=3, p=1) is the WRITER path — PBKDF2 is memory-less, so a
 * consumer GPU manages roughly 8,000 guesses/s against it; Argon2id at 64 MiB forces
 * real silicon for the same ~1s user-visible cost, which matters because in a
 * zero-knowledge product the KDF *is* the security claim. PBKDF2-HMAC-SHA256 at
 * 600,000 iterations (OWASP 2023+ guidance) is kept as a READER path only, so
 * envelopes written before this change keep unlocking — new wraps are always
 * Argon2id, existing PBKDF2 wraps get rewrapped on next successful unlock (see
 * accountKeys.js's `migrateWrapIfNeeded`).
 */
export const DEFAULT_KDF_PARAMS = Object.freeze({
  name: 'Argon2id',
  memorySize: 65536, // KiB = 64 MiB
  iterations: 3,
  parallelism: 1,
  hashLength: 32, // bytes -- AES-256 key material
});

// Legacy default, still needed to deserialize/derive against envelopes written
// before Argon2id existed. Never used for new wraps.
export const PBKDF2_KDF_PARAMS = Object.freeze({
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 600000,
});

export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Derives a non-extractable AES-GCM KEK from a passphrase, dispatching on
 * `params.name` so callers don't need to know which algorithm produced a given
 * envelope's wrap -- the params travel with the wrap specifically so this can stay
 * a single entry point.
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {object} [params]
 * @returns {Promise<CryptoKey>} non-extractable AES-GCM 256-bit key
 */
export async function deriveKEK(passphrase, salt, params = DEFAULT_KDF_PARAMS) {
  if (params.name === 'PBKDF2') return deriveKEKPbkdf2(passphrase, salt, params);
  return deriveKEKArgon2id(passphrase, salt, params);
}

async function deriveKEKArgon2id(passphrase, salt, params) {
  const rawKey = await argon2id({
    password: passphrase,
    salt,
    iterations: params.iterations ?? DEFAULT_KDF_PARAMS.iterations,
    parallelism: params.parallelism ?? DEFAULT_KDF_PARAMS.parallelism,
    memorySize: params.memorySize ?? DEFAULT_KDF_PARAMS.memorySize,
    hashLength: params.hashLength ?? DEFAULT_KDF_PARAMS.hashLength,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['wrapKey', 'unwrapKey']);
}

async function deriveKEKPbkdf2(passphrase, salt, params) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: params.iterations ?? PBKDF2_KDF_PARAMS.iterations,
      hash: params.hash ?? PBKDF2_KDF_PARAMS.hash,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/** True if `params` are below the current writer policy and should be rewrapped on unlock. */
export function isBelowCurrentKdfPolicy(params) {
  return params.name !== DEFAULT_KDF_PARAMS.name;
}

/** Serializes KDF params + salt for storage in an envelope. */
export function serializeKdfParams(salt, params = DEFAULT_KDF_PARAMS) {
  if (params.name === 'PBKDF2') {
    return {
      name: 'PBKDF2',
      hash: params.hash ?? PBKDF2_KDF_PARAMS.hash,
      iterations: params.iterations ?? PBKDF2_KDF_PARAMS.iterations,
      salt: bufToBase64(salt),
    };
  }
  return {
    name: 'Argon2id',
    memorySize: params.memorySize ?? DEFAULT_KDF_PARAMS.memorySize,
    iterations: params.iterations ?? DEFAULT_KDF_PARAMS.iterations,
    parallelism: params.parallelism ?? DEFAULT_KDF_PARAMS.parallelism,
    hashLength: params.hashLength ?? DEFAULT_KDF_PARAMS.hashLength,
    salt: bufToBase64(salt),
  };
}

export function deserializeKdfParams(serialized) {
  return { ...serialized, salt: base64ToBuf(serialized.salt) };
}
