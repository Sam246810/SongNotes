# Deployment

## Status: live on Vercel (deployed 2026-08-18)

- Production URL: https://www.songnotes.cloud (also reachable at
  https://song-notes-jet.vercel.app, which still works as the underlying
  `*.vercel.app` domain)
- Project: `ubexsa/song-notes` (dashboard: https://vercel.com/ubexsa/song-notes)
- Deploys: `git push` to `main` auto-deploys via Vercel's GitHub integration;
  `vercel --prod` also works from a local checkout once `vercel link` has run.
- Env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) are set in the
  Vercel project across Production, Preview, and Development — see
  `.env.example` for what they are and why the anon key is safe to expose.

### Custom domain — `songnotes.cloud`, connected 2026-08-20

Registered on Namecheap; DNS stays on Namecheap (not delegated to Vercel's
nameservers) since renewal is cheaper there ($27/yr vs Vercel's $24/yr is a
wash, but keeping DNS separate leaves room for other records like email
later without needing Vercel to manage them). Records set in Namecheap's
Advanced DNS, replacing the default parking records (parking CNAME and URL
redirect on `@`, which conflict with an apex A record and had to be deleted
first):

| Type  | Host | Value                                    |
|-------|------|-------------------------------------------|
| A     | `@`  | `216.198.79.1`                             |
| CNAME | `www`| `96e7f08278a866d2.vercel-dns-017.com`      |

The CNAME target is the project-specific value Vercel's domain settings
page recommends (part of Vercel's expanded IP range) rather than the
generic `cname.vercel-dns.com` — both work, but the specific one is what
Vercel's dashboard shows for this project. `songnotes.cloud` (apex)
redirects (308) to `www.songnotes.cloud`, which serves the app.

Because this is a Vite SPA using `react-router` (`BrowserRouter`, not
`HashRouter` — see `src/main.jsx`), a direct load of a route like
`/delete-account` needs the host configured to rewrite all paths to
`index.html` rather than 404. Vercel doesn't do this automatically for a
`BrowserRouter` SPA, so `vercel.json` at the repo root has an explicit
catch-all rewrite to `index.html` — verified working against the live
deployment.

## Security hardening — status

The August 2026 security review's fixes are committed. One step lived outside the
repo and has been applied; one is a deliberate, owner-made decision, recorded here.

### 1. `supabase/schema.sql` re-run — done, verified 2026-08-19

`delete_own_account` is a `SECURITY DEFINER` function that deletes from `auth.users`. It
used to be executable by the `anon` role: Supabase's default privileges grant EXECUTE on
new `public` functions directly to `anon`, and the original `revoke ... from public` never
touched that direct grant, so an unauthenticated POST returned `204` (the function ran,
though it deleted nothing — `auth.uid()` is null for an anonymous caller). `schema.sql` now
revokes from `anon` explicitly, and the owner re-ran it against the live database.
Confirmed:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/delete_own_account" -H "apikey: $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' -d '{}'
# {"code":"42501","details":null,"hint":null,"message":"permission denied for function delete_own_account"}
```

`42501 permission denied` — fixed. (If this ever regresses back to `204`, the schema needs
re-running again.)

### 2. Password minimum — set to 8, owner decision

A pure security read of this architecture argues for a longer minimum: the account
password is a KDF input, not just a login credential, and a short one is the real floor
under "unreadable even to someone with full database access" even with Argon2id in front
of it (~28 bits at the old 6-character default; the recovery code, ~100 bits, was never
the weak link). The original recommendation was 12.

**The owner chose 8 instead — a deliberate compromise, not an oversight** — trading some
of that margin against staying close to a length people don't fight the signup form over.
`src/auth/passwordPolicy.js`'s `MIN_PASSWORD_LENGTH` is set to 8 and enforced in real JS
(not just the bypassable HTML `minLength`). **The Supabase dashboard's server-side minimum
(Authentication → Providers → minimum password length) must be set to 8 to match** —
client-side length alone is advisory, not a binding control.

**This is shared with the Android client, so raising the server minimum has one
consequence to know about:**

- **Safe:** sign-in never checks length (LoginPage deliberately has no `minLength`), so
  every existing account — including any Android-created 6-character one — keeps working
  everywhere. Nobody already signed up gets locked out.
- **Affected:** signup and password-change *on Android*, whose own UI still shows a
  6-character minimum (a separate repo, not touched by this work). A user could type a
  6-or-7-character password there, have Android's UI accept it, and have the server
  reject it — a rough edge until Android's own minimum is raised to match. Not this
  round's scope.

## Before this app can go to the Play Store

Account deletion (`src/auth/DeleteAccountPage.jsx`) is a hard Play Store
requirement — see the Android repo's `docs/DATA_SAFETY_FORM.md`. The web
side is done (deployed above); what's left is Android-repo work, tracked
there rather than here:

1. Update `WebLinks.kt`'s `WEB_DELETE_ACCOUNT_URL` in the Android repo from
   the `https://example.com/delete-account` placeholder to
   `https://www.songnotes.cloud/delete-account`.
2. Play Console → App content → Data safety → Account deletion. Play checks
   that field independently of what the app links to — filling in one
   doesn't populate the other.

(`example.com` was used as the placeholder because it's IANA-reserved for
documentation/placeholder use, so it couldn't collide with anyone's real
site in the meantime — the same reasoning already applied to the
forgot-password link, where `songnotes.app` was tried first and turned out
to be a live, unrelated third-party product.)
