import { describe, it, expect, beforeEach } from 'vitest';
import {
  recoverWithRecoveryCode, rotateAndPurge, regenerateRecoveryCode, changePassword, hasAccountKeys,
  deleteAccount,
} from '../auth/accountRecovery';
import { createAccountKeys, generateRecoveryCode, unlockWithPassphrase } from '../crypto/accountKeys';
import { encryptJSON, decryptJSON } from '../crypto/envelope';
import { clearSession, getDEK, establishDEK } from '../crypto/keyManager';

/**
 * In-memory stand-in for SupabaseUserKeysAdapter — same shape (get/create/update),
 * same failure semantics (23505 on a conflicting create, a conflict on a stale
 * update), no network. This is what makes accountRecovery.js's ordering claims
 * checkable instead of just asserted in a comment: every test below injects a
 * failure at one specific step and then verifies BOTH the resulting server state
 * AND that a fresh attempt afterward still succeeds — i.e. the "self-healing"
 * claim in accountRecovery.js's own doc comment.
 */
class FakeUserKeysAdapter {
  constructor(initial = null) {
    this.row = initial; // { envelope, rev } | null
    this.calls = { get: 0, create: 0, update: 0 };
    // One-shot hook fired right after a get() snapshot is taken (but returned to
    // the caller as if nothing happened) — for simulating "another
    // client's write landed between our read and our write" races, which a
    // synchronous in-memory fake can't otherwise produce.
    this._afterNextGet = null;
  }
  async get() {
    this.calls.get++;
    const snapshot = this.row ? { envelope: this.row.envelope, rev: this.row.rev } : null;
    if (this._afterNextGet) {
      const hook = this._afterNextGet;
      this._afterNextGet = null;
      hook(this);
    }
    return snapshot;
  }
  async create(envelope) {
    this.calls.create++;
    if (this.row) {
      const err = new Error('duplicate key value violates unique constraint "user_keys_pkey"');
      err.code = '23505';
      throw err;
    }
    this.row = { envelope, rev: 1 };
    return 1;
  }
  async update(envelope, expectedRev) {
    this.calls.update++;
    if (!this.row || this.row.rev !== expectedRev) {
      const err = new Error('user_keys envelope changed since it was last read (rev conflict)');
      err.conflict = true;
      throw err;
    }
    this.row = { envelope, rev: expectedRev + 1 };
    return { rev: this.row.rev };
  }
}

/** Mirrors songsRepository.test.js's FakeRemoteAdapter, plus deleteAll for the purge path. */
class FakeSongsAdapter {
  constructor() {
    this.rows = new Map();
  }
  async list() {
    return [...this.rows.values()];
  }
  async insert(row) {
    this.rows.set(row.id, row);
    return row;
  }
  async updateWithRevCheck(id, row, expectedRev) {
    const current = this.rows.get(id);
    if (!current || current.rev !== expectedRev) return { conflict: true };
    this.rows.set(id, row);
    return { conflict: false, row };
  }
  async deleteAll() {
    this.rows.clear();
  }
}

/** A network/GoTrue call that fails exactly once, then succeeds — for retry tests. */
function makeAuthClient({ fail, failWith } = {}) {
  let remainingFailures = fail ?? 0;
  return {
    calls: [],
    async updateUser(payload) {
      this.calls.push(payload);
      if (remainingFailures > 0) {
        remainingFailures--;
        return { data: null, error: failWith || new Error('network error') };
      }
      return { data: { user: {} }, error: null };
    },
  };
}

const USER_ID = 'user-1';

async function seedAccount(password, recoveryCode) {
  const { dek, envelope } = await createAccountKeys(password, recoveryCode);
  return { dek, keysAdapter: new FakeUserKeysAdapter({ envelope, rev: 1 }) };
}

describe('recoverWithRecoveryCode (Path A)', () => {
  const OLD_PASSWORD = 'old-passphrase';
  const NEW_PASSWORD = 'new-passphrase';
  let recoveryCode;

  beforeEach(() => {
    clearSession();
    recoveryCode = generateRecoveryCode();
  });

  it('happy path: unlocks, sets the new password, rewraps, establishes the DEK', async () => {
    const { dek, keysAdapter } = await seedAccount(OLD_PASSWORD, recoveryCode);
    const authClient = makeAuthClient();

    const result = await recoverWithRecoveryCode({
      userId: USER_ID, code: recoveryCode, newPassword: NEW_PASSWORD, authClient, keysAdapter,
    });

    expect(getDEK()).toBeTruthy();
    // Old password no longer works; recovery code still does.
    await expect(unlockWithPassphrase(keysAdapter.row.envelope, OLD_PASSWORD)).rejects.toThrow();
    const viaNewPassword = await unlockWithPassphrase(keysAdapter.row.envelope, NEW_PASSWORD);
    const probe = { still: 'works' };
    const ct = await encryptJSON(dek, probe);
    expect(await decryptJSON(viaNewPassword, ct)).toEqual(probe);
    expect(result.dek).toBeTruthy();
  });

  it('accepts a code typed lowercase without hyphens (normalization)', async () => {
    const { keysAdapter } = await seedAccount(OLD_PASSWORD, recoveryCode);
    const authClient = makeAuthClient();
    const messyCode = recoveryCode.toLowerCase().replace(/-/g, ' ');

    await recoverWithRecoveryCode({ userId: USER_ID, code: messyCode, newPassword: NEW_PASSWORD, authClient, keysAdapter });
    expect(getDEK()).toBeTruthy();
  });

  it('step 1 (no envelope): throws a tagged error, nothing else attempted', async () => {
    const keysAdapter = new FakeUserKeysAdapter(null);
    const authClient = makeAuthClient();

    await expect(
      recoverWithRecoveryCode({ userId: USER_ID, code: recoveryCode, newPassword: NEW_PASSWORD, authClient, keysAdapter })
    ).rejects.toMatchObject({ noEnvelope: true });
    expect(authClient.calls).toHaveLength(0);
    expect(keysAdapter.calls.update).toBe(0);
  });

  it('step 2 (wrong code): nothing written, envelope untouched, a correct retry then succeeds', async () => {
    const { keysAdapter } = await seedAccount(OLD_PASSWORD, recoveryCode);
    const authClient = makeAuthClient();
    const originalEnvelope = keysAdapter.row.envelope;

    await expect(
      recoverWithRecoveryCode({ userId: USER_ID, code: 'WRONG-CODE-ENTIRELY', newPassword: NEW_PASSWORD, authClient, keysAdapter })
    ).rejects.toThrow();
    expect(keysAdapter.row.envelope).toBe(originalEnvelope); // untouched, same object
    expect(authClient.calls).toHaveLength(0); // never even reached step 3

    // Retry with the correct code succeeds.
    await recoverWithRecoveryCode({ userId: USER_ID, code: recoveryCode, newPassword: NEW_PASSWORD, authClient, keysAdapter });
    expect(getDEK()).toBeTruthy();
  });

  it('step 3 (updateUser network failure): envelope untouched, a retry then succeeds', async () => {
    const { keysAdapter } = await seedAccount(OLD_PASSWORD, recoveryCode);
    const authClient = makeAuthClient({ fail: 1 });
    const originalEnvelope = keysAdapter.row.envelope;

    await expect(
      recoverWithRecoveryCode({ userId: USER_ID, code: recoveryCode, newPassword: NEW_PASSWORD, authClient, keysAdapter })
    ).rejects.toThrow();
    expect(keysAdapter.row.envelope).toBe(originalEnvelope);
    expect(keysAdapter.calls.update).toBe(0);

    await recoverWithRecoveryCode({ userId: USER_ID, code: recoveryCode, newPassword: NEW_PASSWORD, authClient, keysAdapter });
    expect(getDEK()).toBeTruthy();
  });

  it('step 3 (same_password): treated as success, falls through to the rewrap instead of failing', async () => {
    const { keysAdapter } = await seedAccount(OLD_PASSWORD, recoveryCode);
    const sameError = new Error('New password should be different from the old password.');
    sameError.code = 'same_password';
    const authClient = makeAuthClient({ fail: 1, failWith: sameError });

    // Simulates the "updateUser actually committed, but the client never saw the
    // response" case: the retry re-submits the SAME newPassword and GoTrue
    // rejects it as unchanged — this must still complete the recovery.
    await recoverWithRecoveryCode({ userId: USER_ID, code: recoveryCode, newPassword: NEW_PASSWORD, authClient, keysAdapter });

    expect(getDEK()).toBeTruthy();
    expect(keysAdapter.calls.update).toBe(1);
    const viaNewPassword = await unlockWithPassphrase(keysAdapter.row.envelope, NEW_PASSWORD);
    expect(viaNewPassword).toBeTruthy();
  });

  it('step 4 (rev conflict on the envelope update): leaves auth=new/envelope=old ("State X"), self-heals on retry via the SAME recovery code + the now-current password', async () => {
    const { keysAdapter } = await seedAccount(OLD_PASSWORD, recoveryCode);
    const authClient = makeAuthClient();

    // Force a rev conflict AFTER our own get() has already taken its snapshot —
    // simulates a concurrent writer landing in the gap between our read and our
    // eventual update(), which a synchronous fake can't otherwise produce.
    keysAdapter._afterNextGet = (adapter) => { adapter.row.rev = 99; };

    await expect(
      recoverWithRecoveryCode({ userId: USER_ID, code: recoveryCode, newPassword: NEW_PASSWORD, authClient, keysAdapter })
    ).rejects.toMatchObject({ conflict: true });

    // State X: the auth client DID get the updateUser call (irreversible from
    // this function's point of view — that's exactly why it's step 3, before
    // the envelope write) but the envelope is still on the OLD password.
    expect(authClient.calls).toHaveLength(1);
    await expect(unlockWithPassphrase(keysAdapter.row.envelope, OLD_PASSWORD)).resolves.toBeTruthy();

    // Retry: recovery wrap is untouched, so the same code still works; newPassword
    // is now the CURRENT auth password, so step 3 hits the same_password path.
    await recoverWithRecoveryCode({ userId: USER_ID, code: recoveryCode, newPassword: NEW_PASSWORD, authClient, keysAdapter });
    expect(getDEK()).toBeTruthy();
    await expect(unlockWithPassphrase(keysAdapter.row.envelope, NEW_PASSWORD)).resolves.toBeTruthy();
  });
});

describe('rotateAndPurge (Path B)', () => {
  beforeEach(() => clearSession());

  it('mints a new DEK/code, purges every song, blocks on onRecoveryCode before writing', async () => {
    const { keysAdapter } = await seedAccount('old-passphrase', generateRecoveryCode());
    const authClient = makeAuthClient();
    const songsAdapter = new FakeSongsAdapter();
    await songsAdapter.insert({ id: 'song-1', user_id: USER_ID, rev: 1, content: {} });
    await songsAdapter.insert({ id: 'song-2', user_id: USER_ID, rev: 1, content: {} });

    let resolveGate;
    const gate = new Promise((resolve) => { resolveGate = resolve; });
    let resolveCalled;
    const calledPromise = new Promise((resolve) => { resolveCalled = resolve; });
    let codeShown = null;
    let writesBeforeGateResolved = null;

    const promise = rotateAndPurge({
      userId: USER_ID,
      newPassword: 'brand-new-password',
      authClient,
      keysAdapter,
      songsAdapter,
      onRecoveryCode: async (code) => {
        codeShown = code;
        writesBeforeGateResolved = keysAdapter.calls.update + keysAdapter.calls.create;
        resolveCalled();
        await gate; // nothing downstream may proceed until this resolves
      },
    });

    // Wait for the callback to actually fire — createAccountKeys does real
    // Argon2id work first (real wall-clock time, not just a microtask), so a
    // fixed number of `await Promise.resolve()` ticks isn't enough here.
    await calledPromise;
    expect(codeShown).toEqual(expect.any(String));
    expect(writesBeforeGateResolved).toBe(0); // confirmed: shown BEFORE anything is written

    resolveGate();
    const result = await promise;

    expect(result.recoveryCode).toBe(codeShown);
    expect(songsAdapter.rows.size).toBe(0); // every song purged
    expect(getDEK()).toBeTruthy();
    await expect(unlockWithPassphrase(keysAdapter.row.envelope, 'brand-new-password')).resolves.toBeTruthy();
  });

  it('works even when no envelope exists yet (create instead of update)', async () => {
    const keysAdapter = new FakeUserKeysAdapter(null);
    const authClient = makeAuthClient();
    const songsAdapter = new FakeSongsAdapter();

    const result = await rotateAndPurge({
      userId: USER_ID, newPassword: 'brand-new-password', authClient, keysAdapter, songsAdapter,
      onRecoveryCode: () => {},
    });

    expect(keysAdapter.calls.create).toBe(1);
    expect(keysAdapter.calls.update).toBe(0);
    expect(result.dek).toBeTruthy();
  });
});

describe('regenerateRecoveryCode', () => {
  beforeEach(() => clearSession());

  it('mints a new code without touching the passphrase wrap', async () => {
    const password = 'a-passphrase';
    const { dek, keysAdapter } = await seedAccount(password, generateRecoveryCode());

    const { recoveryCode: newCode } = await regenerateRecoveryCode({ userId: USER_ID, dek, keysAdapter });

    expect(newCode).toEqual(expect.any(String));
    await expect(unlockWithPassphrase(keysAdapter.row.envelope, password)).resolves.toBeTruthy();
  });
});

describe('changePassword', () => {
  beforeEach(() => clearSession());

  it('rewraps the envelope for the new password after updateUser succeeds', async () => {
    const oldPassword = 'old-passphrase';
    const newPassword = 'new-passphrase';
    const { dek, keysAdapter } = await seedAccount(oldPassword, generateRecoveryCode());
    const authClient = makeAuthClient();

    await changePassword({ userId: USER_ID, dek, newPassword, authClient, keysAdapter });

    await expect(unlockWithPassphrase(keysAdapter.row.envelope, oldPassword)).rejects.toThrow();
    await expect(unlockWithPassphrase(keysAdapter.row.envelope, newPassword)).resolves.toBeTruthy();
  });
});

describe('deleteAccount', () => {
  beforeEach(() => clearSession());

  it('calls the delete_own_account RPC, clears the DEK session, and signs out', async () => {
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    await establishDEK(dek, USER_ID, 'dek-1');
    expect(getDEK()).toBeTruthy();

    const rpcCalls = [];
    const rpc = async (fn) => { rpcCalls.push(fn); return { error: null }; };
    let signOutCalls = 0;
    const authClient = { signOut: async () => { signOutCalls++; return { error: null }; } };

    await deleteAccount({ authClient, rpc });

    expect(rpcCalls).toEqual(['delete_own_account']);
    expect(signOutCalls).toBe(1);
    expect(getDEK()).toBeNull();
  });

  it('propagates an RPC error and leaves the session alone (no signOut attempted)', async () => {
    const rpc = async () => ({ error: new Error('permission denied') });
    let signOutCalls = 0;
    const authClient = { signOut: async () => { signOutCalls++; return { error: null }; } };

    await expect(deleteAccount({ authClient, rpc })).rejects.toThrow('permission denied');
    expect(signOutCalls).toBe(0);
  });

  it('still clears the DEK session even if signOut itself fails (best-effort cleanup)', async () => {
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    await establishDEK(dek, USER_ID, 'dek-1');

    const rpc = async () => ({ error: null });
    const authClient = { signOut: async () => { throw new Error('network error'); } };

    await expect(deleteAccount({ authClient, rpc })).resolves.toBeUndefined();
    expect(getDEK()).toBeNull();
  });

  it('wipes the cached ciphertext rows and migration flags off the device', async () => {
    // The server side of deletion cascades from auth.users, but nothing used to remove
    // the LOCAL cache — an account's encrypted rows, row ids and timestamps outlived
    // deletion in localStorage indefinitely. Verified live against a real deleted
    // account during the August 2026 review, hence this regression test.
    localStorage.setItem(`songnotes_cloud_cache:${USER_ID}`, JSON.stringify([{ id: 'song-1', content: { ct: 'ciphertext' } }]));
    localStorage.setItem('songnotes_cloud_cache:some-other-user', JSON.stringify([{ id: 'song-2' }]));
    localStorage.setItem(`songnotes_migrated:${USER_ID}`, 'true');
    localStorage.setItem('unrelated_key', 'keep me');

    const rpc = async () => ({ error: null });
    const authClient = { signOut: async () => ({ error: null }) };
    await deleteAccount({ authClient, rpc });

    expect(localStorage.getItem(`songnotes_cloud_cache:${USER_ID}`)).toBeNull();
    expect(localStorage.getItem(`songnotes_migrated:${USER_ID}`)).toBeNull();
    // Swept for every user, not just the active one: a crashed session can leave an
    // entry behind for an account that is no longer current, and that is exactly the
    // copy nobody would think to clear.
    expect(localStorage.getItem('songnotes_cloud_cache:some-other-user')).toBeNull();
    // ...but nothing outside the two namespaces, including guest-mode songs.
    expect(localStorage.getItem('unrelated_key')).toBe('keep me');
  });
});

describe('hasAccountKeys', () => {
  it('reports true/false based on whether an envelope row exists', async () => {
    const { keysAdapter } = await seedAccount('a-passphrase', generateRecoveryCode());
    expect(await hasAccountKeys(USER_ID, { keysAdapter })).toBe(true);
    expect(await hasAccountKeys(USER_ID, { keysAdapter: new FakeUserKeysAdapter(null) })).toBe(false);
  });
});
