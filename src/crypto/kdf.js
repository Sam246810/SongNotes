import { bufToBase64, base64ToBuf } from './base64';

/**
 * Key derivation — turns a human passphrase (account passphrase, recovery code, or
 * per-song password) into an AES-GCM key-encryption-key (KEK), never persisted.
 *
 * PBKDF2-HMAC-SHA256 at 600,000 iterations (OWASP 2023+ guidance for PBKDF2-SHA256).
 * KDF params travel alongside the salt in every envelope so a future upgrade to
 * Argon2id is a drop-in: unwrap with the recorded params, re-wrap with new ones.
 */
export const DEFAULT_KDF_PARAMS = Object.freeze({
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 600000,
});

export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {{iterations?: number, hash?: string}} [params]
 * @returns {Promise<CryptoKey>} non-extractable AES-GCM 256-bit key
 */
export async function deriveKEK(passphrase, salt, params = DEFAULT_KDF_PARAMS) {
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
      iterations: params.iterations ?? DEFAULT_KDF_PARAMS.iterations,
      hash: params.hash ?? DEFAULT_KDF_PARAMS.hash,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/** Serializes KDF params + salt for storage in an envelope. */
export function serializeKdfParams(salt, params = DEFAULT_KDF_PARAMS) {
  return {
    name: params.name ?? DEFAULT_KDF_PARAMS.name,
    hash: params.hash ?? DEFAULT_KDF_PARAMS.hash,
    iterations: params.iterations ?? DEFAULT_KDF_PARAMS.iterations,
    salt: bufToBase64(salt),
  };
}

export function deserializeKdfParams(serialized) {
  return { ...serialized, salt: base64ToBuf(serialized.salt) };
}
