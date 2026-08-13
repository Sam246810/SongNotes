/**
 * Thin wrapper around the Supabase `user_keys` table — one row per user holding their
 * wrapped account DEK envelope (see src/crypto/accountKeys.js). No crypto here; this
 * only moves the opaque envelope JSON in and out of Postgres.
 *
 * Every write is guarded by `envelope_rev` (mirroring `songs.rev`'s optimistic
 * concurrency) — this row is the one thing in the schema whose loss is
 * unrecoverable-by-construction, and it used to be the only one written with a
 * blind upsert. `create()` uses a real INSERT (conflicts on the `user_id` primary
 * key instead of silently overwriting a row a concurrent request just created for
 * a *different* DEK), and `update()` requires the caller's last-known rev to
 * still match. There is deliberately no `upsert()` — every caller must decide
 * "this should not exist yet" vs. "this must still be at rev N" explicitly.
 */
export class SupabaseUserKeysAdapter {
  constructor(client, userId) {
    this.client = client;
    this.userId = userId;
  }

  /** @returns {Promise<{envelope: object, rev: number}|null>} null if no row exists yet. */
  async get() {
    const { data, error } = await this.client
      .from('user_keys')
      .select('envelope, envelope_rev')
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { envelope: data.envelope, rev: data.envelope_rev };
  }

  /**
   * Inserts a brand-new envelope. Throws (Postgres 23505, unique_violation) if a
   * row for this user already exists — callers reacting to `get()` returning
   * `null` should treat that as "someone else just created it, go re-read"
   * rather than silently overwriting a live DEK's envelope with a new one.
   * @returns {Promise<number>} the new row's envelope_rev (always 1).
   */
  async create(envelope) {
    const { error } = await this.client
      .from('user_keys')
      .insert({ user_id: this.userId, envelope, envelope_rev: 1, updated_at: new Date().toISOString() });
    if (error) throw error;
    return 1;
  }

  /**
   * Replaces the envelope, but only if it's still at `expectedRev` — a stale
   * write (another tab/device updated it first) is reported as a conflict
   * instead of silently clobbering whatever they wrote.
   * @returns {Promise<{rev: number}>} the new rev on success.
   * @throws {Error & {conflict: true}} if no row matched (rev moved or row is gone).
   */
  async update(envelope, expectedRev) {
    const nextRev = expectedRev + 1;
    const { data, error } = await this.client
      .from('user_keys')
      .update({ envelope, envelope_rev: nextRev, updated_at: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq('envelope_rev', expectedRev)
      .select('envelope_rev')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const conflictError = new Error('user_keys envelope changed since it was last read (rev conflict)');
      conflictError.conflict = true;
      throw conflictError;
    }
    return { rev: data.envelope_rev };
  }
}
