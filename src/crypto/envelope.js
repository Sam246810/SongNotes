import { bufToBase64, base64ToBuf } from './base64';

/**
 * Single chokepoint for AES-GCM-256 encryption. Callers can never pass their own IV —
 * a fresh random 96-bit IV is generated on every call, which is what makes AES-GCM safe
 * to reuse a key across many writes. Never weaken this guarantee.
 */
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12; // 96-bit, the recommended/optimal IV size for AES-GCM

/** Generate a random 256-bit AES-GCM data/content key (DEK or per-song CK). */
export async function generateContentKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

/**
 * Encrypt a JSON-serializable value with the given AES-GCM key.
 * @returns {Promise<{v:number, alg:'AES-GCM', iv:string, ct:string}>}
 */
export async function encryptJSON(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    v: ENVELOPE_VERSION,
    alg: 'AES-GCM',
    iv: bufToBase64(iv),
    ct: bufToBase64(ciphertext),
  };
}

/**
 * Decrypt an envelope produced by encryptJSON. Throws if the key is wrong or the
 * envelope has been tampered with (AES-GCM authentication tag failure).
 */
export async function decryptJSON(key, envelope) {
  const iv = base64ToBuf(envelope.iv);
  const ciphertext = base64ToBuf(envelope.ct);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * Wrap (encrypt) one AES-GCM key with another — used to wrap a DEK/CK with a
 * passphrase-derived KEK. Returns a JSON-serializable envelope (no separate `ct`
 * field; wrapKey's ciphertext already includes the key material + auth tag).
 */
export async function wrapContentKey(kek, contentKey) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.wrapKey('raw', contentKey, kek, { name: 'AES-GCM', iv });
  return { v: ENVELOPE_VERSION, alg: 'AES-GCM', iv: bufToBase64(iv), wrapped: bufToBase64(wrapped) };
}

/** Unwrap a content key (DEK/CK) previously wrapped with wrapContentKey. */
export async function unwrapContentKey(kek, wrappedEnvelope) {
  const iv = base64ToBuf(wrappedEnvelope.iv);
  const wrapped = base64ToBuf(wrappedEnvelope.wrapped);
  return crypto.subtle.unwrapKey(
    'raw',
    wrapped,
    kek,
    { name: 'AES-GCM', iv },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );
}
