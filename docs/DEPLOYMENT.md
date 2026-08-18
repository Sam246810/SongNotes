# Deployment

## Status: not deployed yet

This app has no hosting wired up — no Vercel project, no custom domain, no
CI deploy step. `npm run build` works locally (see `dist/`), but nothing
publishes it anywhere.

## Plan: Vercel (decided 2026-08-15)

Hosting will be Vercel, with a real domain to follow. Until then, the
Android app (see `SongNotes-Android` repo) links out to this web app's
`/delete-account` page using a placeholder URL —
`WebLinks.kt`'s `WEB_DELETE_ACCOUNT_URL`, currently
`https://example.com/delete-account`. `example.com` is IANA-reserved for
documentation/placeholder use, so it can't collide with anyone's real site
in the meantime (the same reasoning already applied to the forgot-password
link — `songnotes.app` was tried first and turned out to be a live,
unrelated third-party product).

Because this is a Vite SPA using `react-router` (`BrowserRouter`, not
`HashRouter` — see `src/main.jsx`), a direct load of a route like
`/delete-account` needs the host configured to rewrite all paths to
`index.html` rather than 404. Vercel does this automatically for Vite
projects it auto-detects; if that ever needs to be explicit, add a
`vercel.json` with a catch-all rewrite.

## Before this app can go to the Play Store

Account deletion (`src/auth/DeleteAccountPage.jsx`) is a hard Play Store
requirement — see the Android repo's `docs/DATA_SAFETY_FORM.md`. Two steps
remain, both account-holder actions outside what a coding session can do
on its own:

1. **Deploy this app to Vercel** and get a real domain.
2. Update two places with the real URL, once it exists:
   - `WebLinks.kt`'s `WEB_DELETE_ACCOUNT_URL` in the Android repo (the app's
     in-app link).
   - Play Console → App content → Data safety → Account deletion. Play
     checks that field independently of what the app links to — filling in
     one doesn't populate the other.
