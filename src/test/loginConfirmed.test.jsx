import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../auth/AuthContext';
import LoginPage from '../auth/LoginPage';

function Harness({ url, initialUser, onSignOut }) {
  const [user, setUser] = useState(initialUser);
  // Like the real AuthProvider: signing out clears the session.
  const signOut = async () => { onSignOut(); setUser(null); };
  return (
    <AuthContext.Provider value={{ configured: true, signIn: vi.fn(), user, signOut }}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>APP HOME</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function renderAt(url, { user, signOut }) {
  return render(<Harness url={url} initialUser={user} onSignOut={signOut} />);
}

describe('LoginPage after the signup confirmation link', () => {
  it('drops the password-less link session and asks for a real sign-in', async () => {
    const signOut = vi.fn().mockResolvedValue();
    await act(async () => {
      renderAt('/login?confirmed=1', { user: { id: 'u1' }, signOut });
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('APP HOME')).toBeNull();
    expect(screen.getByText(/Email confirmed/)).toBeTruthy();
  });

  it('still redirects an already signed-in user on a plain /login visit', () => {
    const signOut = vi.fn();
    renderAt('/login', { user: { id: 'u1' }, signOut });
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByText('APP HOME')).toBeTruthy();
  });
});
