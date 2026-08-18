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
