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
 * Bounds for KDF parameters read off a stored envelope.
 *
 * These are DoS and structural guards, NOT a security floor — a deliberate distinction.
 * `deriveKEK` dispatches on parameters that arrive from the server, and passed them
 * straight to Argon2id unchecked: an envelope claiming `memorySize: 4194304` (4 GiB) or
 * a nine-digit iteration count would hang or OOM the tab. Equally, an unrecognized
 * `kdf.name` used to fall through the `if (PBKDF2)` check and get silently treated as
 * Argon2id, deriving a garbage key and reporting it as a wrong password.
 *
 * What these must NOT do is reject weak-but-legitimate parameters. WIRE-FORMAT-v2 §3.3
 * ("KDF upgrade on unlock") requires a client to *read* a below-policy wrap — a legacy
 * PBKDF2 entry, or a lower Argon2 t/m than today's default — precisely so it can rewrap
 * it at current policy afterwards. A floor here would make those envelopes permanently
 * unreadable instead of upgradeable, and would reject envelopes written by the Android
 * client if it ever ships different-but-valid parameters. So the floors are set at
 * "structurally sane", not "currently recommended".
 *
 * Canonical on-the-wire values, for reference (WIRE-FORMAT-v2 §3): Argon2id
 * memorySize=65536 KiB, iterations=3, parallelism=1, hashLength=32, 16-byte salt;
 * legacy PBKDF2 SHA-256 at 600,000 iterations. Every bound below admits those.
 */
const KDF_LIMITS = Object.freeze({
  Argon2id: {
    memorySize: [1024, 262144],   // KiB — 1 MiB .. 256 MiB (canonical 65536)
    iterations: [1, 16],          // canonical 3
    parallelism: [1, 16],         // canonical 1
  },
  PBKDF2: {
    iterations: [1, 10000000],    // canonical 600000; cap is the DoS guard
    hashes: ['SHA-256', 'SHA-384', 'SHA-512'],
  },
  // AES-256 key material. Both implementations write 32; anything else would fail
  // importKey anyway, so rejecting here just turns a cryptic WebCrypto error into a
  // legible one.
  hashLength: 32,
  saltBytes: [8, 64],             // canonical 16
});

function assertInt(value, [min, max], label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Unsupported KDF parameter: ${label}=${value} (expected an integer in ${min}..${max})`);
  }
}

/**
 * Validates parameters deserialized from an envelope before they reach a KDF.
 * @throws {Error} with a legible message if anything is out of range or unrecognized.
 */
export function validateKdfParams(params) {
  const name = params?.name;
  if (name !== 'Argon2id' && name !== 'PBKDF2') {
    // Previously fell through to Argon2id, which derived a wrong key and surfaced as
    // "incorrect password" — an unrecognized algorithm is a different failure and
    // should say so.
    throw new Error(`Unsupported KDF algorithm: ${JSON.stringify(name)}`);
  }
  if (name === 'Argon2id') {
    const L = KDF_LIMITS.Argon2id;
    assertInt(params.memorySize ?? DEFAULT_KDF_PARAMS.memorySize, L.memorySize, 'memorySize');
    assertInt(params.iterations ?? DEFAULT_KDF_PARAMS.iterations, L.iterations, 'iterations');
    assertInt(params.parallelism ?? DEFAULT_KDF_PARAMS.parallelism, L.parallelism, 'parallelism');
    const hashLength = params.hashLength ?? DEFAULT_KDF_PARAMS.hashLength;
    if (hashLength !== KDF_LIMITS.hashLength) {
      throw new Error(`Unsupported KDF parameter: hashLength=${hashLength} (expected ${KDF_LIMITS.hashLength})`);
    }
  } else {
    assertInt(params.iterations ?? PBKDF2_KDF_PARAMS.iterations, KDF_LIMITS.PBKDF2.iterations, 'iterations');
    const hash = params.hash ?? PBKDF2_KDF_PARAMS.hash;
    if (!KDF_LIMITS.PBKDF2.hashes.includes(hash)) {
      throw new Error(`Unsupported KDF parameter: hash=${JSON.stringify(hash)}`);
    }
  }
  return params;
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
  validateKdfParams(params);
  const saltBytes = salt instanceof Uint8Array ? salt : new Uint8Array(salt ?? []);
  const [minSalt, maxSalt] = KDF_LIMITS.saltBytes;
  if (saltBytes.length < minSalt || saltBytes.length > maxSalt) {
    throw new Error(`Unsupported KDF salt length: ${saltBytes.length} bytes (expected ${minSalt}..${maxSalt})`);
  }
  if (params.name === 'PBKDF2') return deriveKEKPbkdf2(passphrase, saltBytes, params);
  return deriveKEKArgon2id(passphrase, saltBytes, params);
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
