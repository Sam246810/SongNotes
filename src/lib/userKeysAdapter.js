/**
 * Thin wrapper around the Supabase `user_keys` table — one row per user holding their
 * wrapped account DEK envelope (see src/crypto/accountKeys.js). No crypto here; this
 * only moves the opaque envelope JSON in and out of Postgres.
 */
export class SupabaseUserKeysAdapter {
  constructor(client, userId) {
    this.client = client;
    this.userId = userId;
  }

  /** @returns {Promise<object|null>} the stored envelope, or null if none exists yet. */
  async get() {
    const { data, error } = await this.client
      .from('user_keys')
      .select('envelope')
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw error;
    return data?.envelope ?? null;
  }

  async upsert(envelope) {
    const { error } = await this.client
      .from('user_keys')
      .upsert({ user_id: this.userId, envelope, updated_at: new Date().toISOString() });
    if (error) throw error;
  }
}
