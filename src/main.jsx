import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './styles/global.css';
import App from './App.jsx';
import AuthProvider from './auth/AuthProvider.jsx';
import LoginPage from './auth/LoginPage.jsx';
import SignupPage from './auth/SignupPage.jsx';
import ForgotPasswordPage from './auth/ForgotPasswordPage.jsx';
import ResetPasswordPage from './auth/ResetPasswordPage.jsx';
import AccountPage from './auth/AccountPage.jsx';
import DeleteAccountPage from './auth/DeleteAccountPage.jsx';
import MobileAppPromo from './components/MobileAppPromo/MobileAppPromo.jsx';
import isMobileDevice from './utils/isMobileDevice.js';

const root = createRoot(document.getElementById('root'));

// Password-reset emails are opened on phones far more often than not — a
// Supabase recovery link carries a one-time token in the URL that gets
// consumed and discarded the instant this module runs (see
// supabaseClient.js), whether or not anything ends up rendering it. So these
// two paths must always reach the real router, even though the rest of the
// web app is desktop-only (see isMobileDevice.js's callers) and everything
// else on mobile gets pointed at the native Android app instead.
//
// '/delete-account' joins them for a different reason: it's the web resource
// the Android app itself links out to for account deletion (Google Play
// requires an actual deletion flow, not just an in-app "contact support"),
// so it's opened almost exclusively FROM a phone and must never bounce back
// to the "install the app" promo.
const MOBILE_GATE_EXEMPT_PATHS = ['/reset-password', '/forgot-password', '/delete-account'];
const isExemptPath = MOBILE_GATE_EXEMPT_PATHS.includes(window.location.pathname);

if (isMobileDevice() && !isExemptPath) {
  root.render(
    <StrictMode>
      <MobileAppPromo />
    </StrictMode>
  );
} else {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/delete-account" element={<DeleteAccountPage />} />
            {/* Accounts are optional — '/' works for guests and signed-in users alike. */}
            <Route path="/*" element={<App />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>
  );
}
