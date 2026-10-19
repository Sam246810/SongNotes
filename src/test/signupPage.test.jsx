import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../auth/AuthContext';
import SignupPage from '../auth/SignupPage';

/**
 * Reproduces Supabase's real ordering with email confirmation off: the session
 * lands (onAuthStateChange -> `user` truthy) BEFORE signUp() resolves, because
 * account-key setup still runs after supabase.auth.signUp() returns.
 */
function Harness({ onReady }) {
  const [user, setUser] = useState(null);
  const signUp = () => new Promise((resolve) => {
    onReady({
      setSession: () => setUser({ id: 'u1' }),
      finish: () => resolve({ user: { id: 'u1' }, session: { user: { id: 'u1' } }, recoveryCode: 'ABCDE-FGHIJ' }),
    });
  });
  return (
    <AuthContext.Provider value={{ configured: true, user, signUp }}>
      <MemoryRouter initialEntries={['/signup']}>
        <Routes>
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/" element={<div>APP HOME</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('SignupPage', () => {
  it('shows the recovery code even when the session arrives before signUp resolves', async () => {
    let controls;
    render(<Harness onReady={(c) => { controls = c; }} />);

    fireEvent.change(document.querySelector('input[type=email]'), { target: { value: 'a@b.co' } });
    fireEvent.change(document.querySelector('input[type=password]'), { target: { value: 'longenough1' } });
    fireEvent.submit(document.querySelector('form'));

    await act(async () => { controls.setSession(); });
    expect(screen.queryByText('APP HOME')).toBeNull();

    await act(async () => { controls.finish(); });
    expect(screen.getByText('ABCDE-FGHIJ')).toBeTruthy();

    fireEvent.click(screen.getByText(/I've saved it/));
    expect(screen.getByText('APP HOME')).toBeTruthy();
  });
});
