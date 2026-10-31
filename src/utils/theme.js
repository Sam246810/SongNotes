import { useSyncExternalStore } from 'react';

const THEME_KEY = 'songnotes-theme';
const DARK_CLASS = 'cozy-dark';
const PREFERENCES = ['light', 'dark', 'system'];

/**
 * The user's theme preference: 'light', 'dark' or 'system' (follow the OS).
 * Nothing saved means 'system'. Every older build saved an explicit 'light' or
 * 'dark' the first time the editor Toolbar mounted, so existing users keep
 * whatever they had.
 *
 * index.html repeats the resolve-and-apply step inline before first paint; keep
 * the two in sync (and re-pin its CSP hash in vercel.json; see csp.test.js).
 */
export function getThemePreference() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return PREFERENCES.includes(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(preference = getThemePreference()) {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

const listeners = new Set();

function applyTheme() {
  document.body.classList.toggle(DARK_CLASS, resolveTheme() === 'dark');
  listeners.forEach((l) => l());
}

export function setThemePreference(preference) {
  if (!PREFERENCES.includes(preference)) return;
  try {
    localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Storage blocked: still switch for this session.
  }
  applyTheme();
}

let followingSystem = false;

/**
 * Follows the OS flipping light/dark under an open tab, on every page: called
 * once at startup (main.jsx). The hook's own listener below only runs while a
 * component using it (Settings, the DAW panel) is on screen, so on its own the
 * song list and editor stayed on the old theme until a reload. Only matters
 * on 'system'; resolveTheme ignores the OS for an explicit choice.
 */
export function followSystemTheme() {
  if (followingSystem || typeof window.matchMedia !== 'function') return;
  followingSystem = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

function subscribe(listener) {
  listeners.add(listener);
  // While on 'system', follow the OS flipping light/dark under an open tab.
  const media = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
  media?.addEventListener('change', applyTheme);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener('change', applyTheme);
  };
}

/** `{ preference, theme }`: what the user picked, and what is actually showing. */
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, getThemePreference);
  const theme = useSyncExternalStore(subscribe, () => resolveTheme(preference));
  return { preference, theme };
}
