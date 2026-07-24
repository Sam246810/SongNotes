import { generateSalt, deriveKEK, serializeKdfParams, deserializeKdfParams } from './kdf';
import { generateContentKey, wrapContentKey, unwrapContentKey } from './envelope';

/**
 * Account-level key envelope: a single random Data Encryption Key (DEK) per user,
 * wrapped TWICE — once by an account-password-derived key, once by a recovery-code-derived
 * key — so either secret independently unlocks it. This whole envelope is what gets
 * stored server-side in `user_keys.envelope`; the DEK itself never is.
 */

/**
 * @param {string} accountPassword
 * @param {string} [recoveryCode]
 * @returns {Promise<{dek: CryptoKey, envelope: object, recoveryCode: string}>}
 */
export async function createAccountKeys(accountPassword, recoveryCode = generateRecoveryCode()) {
  const dek = await generateContentKey();

  const passSalt = generateSalt();
  const passKek = await deriveKEK(accountPassword, passSalt);
  const wrappedByPassphrase = await wrapContentKey(passKek, dek);

  const recoverySalt = generateSalt();
  const recoveryKek = await deriveKEK(recoveryCode, recoverySalt);
  const wrappedByRecovery = await wrapContentKey(recoveryKek, dek);

  const envelope = {
    v: 1,
    passphrase: { kdf: serializeKdfParams(passSalt), wrapped: wrappedByPassphrase },
    recovery: { kdf: serializeKdfParams(recoverySalt), wrapped: wrappedByRecovery },
  };

  return { dek, envelope, recoveryCode };
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

/** @returns {Promise<CryptoKey>} the DEK, or throws if the account password is wrong. */
export async function unlockWithPassphrase(envelope, accountPassword) {
  const { kdf, wrapped } = envelope.passphrase;
  const { salt } = deserializeKdfParams(kdf);
  const kek = await deriveKEK(accountPassword, salt, kdf);
  return unwrapContentKey(kek, wrapped);
}

/** Alias for unlockWithPassphrase */
export const unlockWithAccountPassword = unlockWithPassphrase;

/** @returns {Promise<CryptoKey>} the DEK, or throws if the recovery code is wrong. */
export async function unlockWithRecoveryCode(envelope, recoveryCode) {
  const { kdf, wrapped } = envelope.recovery;
  const { salt } = deserializeKdfParams(kdf);
  const kek = await deriveKEK(recoveryCode, salt, kdf);
  return unwrapContentKey(kek, wrapped);
}

/** After recovering the DEK via the recovery code, set a new account password for it. */
export async function rewrapWithNewPassphrase(envelope, dek, newAccountPassword) {
  const passSalt = generateSalt();
  const passKek = await deriveKEK(newAccountPassword, passSalt);
  const wrappedByPassphrase = await wrapContentKey(passKek, dek);
  return {
    ...envelope,
    passphrase: { kdf: serializeKdfParams(passSalt), wrapped: wrappedByPassphrase },
  };
}
