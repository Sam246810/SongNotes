import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getThemePreference, resolveTheme, setThemePreference } from '../utils/theme';
import SettingsPage from '../components/SettingsPage/SettingsPage';

vi.mock('../auth/useAuth', () => ({ default: () => ({ configured: false, user: null }) }));

// jsdom has no matchMedia; this stands in for the OS light/dark setting.
let osDark = false;
const mediaListeners = new Set();
function setOsDark(dark) {
  osDark = dark;
  mediaListeners.forEach((l) => l());
}

beforeEach(() => {
  localStorage.clear();
  document.body.className = '';
  osDark = false;
  mediaListeners.clear();
  window.matchMedia = () => ({
    get matches() { return osDark; },
    addEventListener: (_, l) => mediaListeners.add(l),
    removeEventListener: (_, l) => mediaListeners.delete(l),
  });
});

afterEach(() => {
  delete window.matchMedia;
});

describe('theme preference', () => {
  it("defaults to 'system' when nothing (or junk) is saved", () => {
    expect(getThemePreference()).toBe('system');
    localStorage.setItem('songnotes-theme', 'purple');
    expect(getThemePreference()).toBe('system');
  });

  it('keeps an explicit light/dark saved by older builds', () => {
    localStorage.setItem('songnotes-theme', 'dark');
    expect(getThemePreference()).toBe('dark');
    expect(resolveTheme()).toBe('dark');
  });

  it("'system' resolves from the OS setting", () => {
    expect(resolveTheme('system')).toBe('light');
    osDark = true;
    expect(resolveTheme('system')).toBe('dark');
  });

  it('setting a preference saves it and applies the body class', () => {
    setThemePreference('dark');
    expect(localStorage.getItem('songnotes-theme')).toBe('dark');
    expect(document.body.classList.contains('cozy-dark')).toBe(true);
    setThemePreference('light');
    expect(document.body.classList.contains('cozy-dark')).toBe(false);
  });
});

describe('SettingsPage theme picker', () => {
  function renderPage() {
    return render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  }

  it('shows the current preference and switches on click', async () => {
    renderPage();
    expect(screen.getByRole('radio', { name: /match system/i })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: /cozy dark/i }));
    expect(screen.getByRole('radio', { name: /cozy dark/i })).toHaveAttribute('aria-checked', 'true');
    expect(document.body.classList.contains('cozy-dark')).toBe(true);
    expect(localStorage.getItem('songnotes-theme')).toBe('dark');
  });

  it("on 'system', follows the OS flipping while the page is open", () => {
    renderPage();
    expect(document.body.classList.contains('cozy-dark')).toBe(false);
    act(() => setOsDark(true));
    expect(document.body.classList.contains('cozy-dark')).toBe(true);
  });

  it('does not offer the account link to guests', () => {
    renderPage();
    expect(screen.queryByText(/recovery code/i)).toBeNull();
  });
});
