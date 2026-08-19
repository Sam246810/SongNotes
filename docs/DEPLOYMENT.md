# Deployment

## Status: live on Vercel (deployed 2026-08-18)

- Production URL: https://song-notes-jet.vercel.app
- Project: `ubexsa/song-notes` (dashboard: https://vercel.com/ubexsa/song-notes)
- Deploys: `git push` to `main` auto-deploys via Vercel's GitHub integration;
  `vercel --prod` also works from a local checkout once `vercel link` has run.
- Env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) are set in the
  Vercel project across Production, Preview, and Development — see
  `.env.example` for what they are and why the anon key is safe to expose.
- No custom domain yet — still on the `*.vercel.app` subdomain.

Because this is a Vite SPA using `react-router` (`BrowserRouter`, not
`HashRouter` — see `src/main.jsx`), a direct load of a route like
`/delete-account` needs the host configured to rewrite all paths to
`index.html` rather than 404. Vercel doesn't do this automatically for a
`BrowserRouter` SPA, so `vercel.json` at the repo root has an explicit
catch-all rewrite to `index.html` — verified working against the live
deployment.

## Security hardening — two steps that are NOT in this repo

The August 2026 security review's code-side fixes are all committed. Two controls live
outside the repo and must be applied by hand; until they are, the committed changes are
only half of each fix.

### 1. Re-run `supabase/schema.sql` (closes the anon-executable RPC)

`delete_own_account` is a `SECURITY DEFINER` function that deletes from `auth.users`, and
the `anon` role holds EXECUTE on it. Supabase's default privileges grant EXECUTE on new
functions in `public` directly to `anon`, and `revoke ... from public` does **not** remove
a grant held directly by a role — so the original revoke was a no-op. An unauthenticated
POST to `/rest/v1/rpc/delete_own_account` returned `204` (the function ran).

It deleted nothing — `auth.uid()` is null for an anonymous caller, so `where id =
auth.uid()` matched zero rows — but it left that function reachable by anyone holding the
publishable key, which ships in the client bundle. `schema.sql` now revokes from `anon`
explicitly. Paste and run the file again, then verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SUPABASE_URL/rest/v1/rpc/delete_own_account" -H "apikey: $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' -d '{}'
```

Expect **401/403 with `42501`**. A `204` means the revoke did not take.

### 2. Raise the server-side minimum password length — read the Android note first

Supabase Dashboard → Authentication → Providers → minimum password length. The client now
requires 12 characters (`src/auth/passwordPolicy.js`), but client-side length is trivially
bypassed; the dashboard setting is the binding control.

Why it matters here specifically: the server holds `user_keys.envelope`, containing the
account DEK wrapped by a KEK derived from this password. Anyone with a copy of that table
can attack it offline with no rate limiting. At the old 6-character default that is ~28
bits — Argon2id at 64 MiB makes each guess expensive but cannot save a keyspace that
small. The recovery code is ~100 bits and was never the weak link.

**This one setting is shared with the Android client, so it is a decision, not a
formality:**

- **Safe:** sign-in never checks length (LoginPage deliberately has no `minLength`), so
  every existing account — including Android-created 6-character ones — keeps working on
  both platforms. Nobody is locked out.
- **Affected:** signup and password-change *on Android*, which still shows a 6-character
  minimum in its own UI. Those users would hit a server rejection the Android UI may
  render poorly. Fixing that is an Android-repo change and was explicitly out of scope.

So: raise it if you accept that Android-side rough edge, or defer it until the Android
client's minimum is raised to match. Deferring leaves the web client's 12-character
requirement in place for web users, which is still a real improvement — it just isn't
enforced against a determined caller.

## Before this app can go to the Play Store

Account deletion (`src/auth/DeleteAccountPage.jsx`) is a hard Play Store
requirement — see the Android repo's `docs/DATA_SAFETY_FORM.md`. The web
side is done (deployed above); what's left is Android-repo work, tracked
there rather than here:

1. Update `WebLinks.kt`'s `WEB_DELETE_ACCOUNT_URL` in the Android repo from
   the `https://example.com/delete-account` placeholder to
   `https://song-notes-jet.vercel.app/delete-account`.
2. Play Console → App content → Data safety → Account deletion. Play checks
   that field independently of what the app links to — filling in one
   doesn't populate the other.

(`example.com` was used as the placeholder because it's IANA-reserved for
documentation/placeholder use, so it couldn't collide with anyone's real
site in the meantime — the same reasoning already applied to the
forgot-password link, where `songnotes.app` was tried first and turned out
to be a live, unrelated third-party product.)
