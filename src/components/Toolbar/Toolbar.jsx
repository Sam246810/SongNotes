import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import useSongsStore from '../../store/songsStore';
import useAuth from '../../auth/useAuth';
import { downloadText, exportToPdf } from '../../utils/export';
import styles from './Toolbar.module.css';

export default function Toolbar({ song, sidebarOpen, onToggleSidebar, showScratchpad, onToggleScratchpad }) {
  const { renameSong, lockSong, relockSong } = useSongsStore();
  const { user } = useAuth();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(song.title);
  const [showExport, setShowExport] = useState(false);
  const titleRef = useRef(null);
  const exportRef = useRef(null);

  // Lock menu: plain toggle for isReadOnly, small dropdown + inline password form
  // for the real crypto lock (password-protect / change password).
  const [lockMenuOpen, setLockMenuOpen] = useState(false);
  const [passwordPromptMode, setPasswordPromptMode] = useState(null); // null | 'set' | 'change'
  const [lockPassword, setLockPassword] = useState('');
  const [confirmLockPassword, setConfirmLockPassword] = useState('');
  const [lockError, setLockError] = useState(null);
  const [lockSubmitting, setLockSubmitting] = useState(false);
  const lockMenuRef = useRef(null);

  const [isDark, setIsDark] = useState(() => {
    return localStorage.getItem('songnotes-theme') === 'dark';
  });

  useEffect(() => {
    if (isDark) {
      document.body.classList.add('cozy-dark');
      localStorage.setItem('songnotes-theme', 'dark');
    } else {
      document.body.classList.remove('cozy-dark');
      localStorage.setItem('songnotes-theme', 'light');
    }
  }, [isDark]);

  // Sync title if song changes externally
  useEffect(() => {
    if (!editingTitle) setTitleDraft(song.title);
  }, [song.title, editingTitle]);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!showExport) return;
    function onClickOutside(e) {
      if (exportRef.current && !exportRef.current.contains(e.target)) setShowExport(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showExport]);

  function resetLockPrompt() {
    setPasswordPromptMode(null);
    setLockPassword('');
    setConfirmLockPassword('');
    setLockError(null);
  }

  const handleAuthRedirect = () => {
    // Snapshot the full decrypted song into sessionStorage so it survives the
    // navigation to /login and back. We use a separate key from the old ID-only
    // approach to avoid any stale data conflicts.
    try {
      sessionStorage.setItem('__songnotes_pending_song_data', JSON.stringify(song));
      // Ensure the book cover doesn't appear when we return post-login.
      sessionStorage.setItem('songnotes_book_opened', 'true');
    } catch (e) {
      console.error('Failed to save pending song data for redirect:', e);
    }
  };

  // Close lock menu on outside click
  useEffect(() => {
    if (!lockMenuOpen) return;
    function onClickOutside(e) {
      if (lockMenuRef.current && !lockMenuRef.current.contains(e.target)) {
        setLockMenuOpen(false);
        resetLockPrompt();
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [lockMenuOpen]);

  function commitTitle() {
    const trimmed = titleDraft.trim() || 'Untitled Song';
    renameSong(song.id, trimmed);
    setTitleDraft(trimmed);
    setEditingTitle(false);
  }

  function handleTitleKey(e) {
    if (e.key === 'Enter') commitTitle();
    if (e.key === 'Escape') {
      setTitleDraft(song.title);
      setEditingTitle(false);
    }
  }

  function handleLockButtonClick() {
    setLockMenuOpen((v) => !v);
    resetLockPrompt();
  }

  async function submitLockPassword(e) {
    e.preventDefault();
    setLockError(null);
    if (lockPassword.length < 8) {
      setLockError('Use at least 8 characters.');
      return;
    }
    if (lockPassword !== confirmLockPassword) {
      setLockError("Passwords don't match.");
      return;
    }
    setLockSubmitting(true);
    try {
      await lockSong(song.id, lockPassword);
      setLockMenuOpen(false);
      resetLockPrompt();
    } catch (err) {
      setLockError(err.message || 'Failed to lock song.');
      setLockSubmitting(false);
    }
  }

  return (
    <div className={`${styles.toolbar} no-print`}>
      {/* Title */}
      <div className={styles.titleArea}>
        {editingTitle ? (
          <input
            ref={titleRef}
            className={styles.titleInput}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={handleTitleKey}
            autoFocus
            spellCheck={false}
            aria-label="Song title"
            id="song-title-input"
          />
        ) : (
          <button
            className={styles.titleBtn}
            onClick={() => setEditingTitle(true)}
            title="Click to rename"
            aria-label="Song title — click to edit"
            id="song-title-btn"
          >
            {song.title}
            <span className={styles.editIcon}>✎</span>
          </button>
        )}
      </div>

      {/* Actions */}
      <div className={styles.actions}>
        {/* Theme Toggle */}
        <button
          className={`${styles.btn} ${isDark ? styles.btnActive : ''}`}
          onClick={() => setIsDark(d => !d)}
          title={isDark ? 'Switch to Warm Light Theme' : 'Switch to Cozy Dark Theme'}
          id="theme-toggle-btn"
        >
          {isDark ? '🌅 Warm Light' : '🕯️ Cozy Dark'}
        </button>

        {/* Scratchpad Toggle */}
        <button
          className={`${styles.btn} ${showScratchpad ? styles.btnActive : ''}`}
          onClick={onToggleScratchpad}
          title={showScratchpad ? 'Hide Scratchpad' : 'Open Scratchpad'}
          id="scratchpad-toggle-btn"
        >
          🎛️ {showScratchpad ? 'Hide Scratchpad' : 'Scratchpad'}
        </button>

        {/* Lock / Read-only / Password-protect */}
        <div className={styles.exportWrap} ref={lockMenuRef}>
          <button
            className={`${styles.btn} ${song.isLocked ? styles.btnWarning : ''}`}
            onClick={handleLockButtonClick}
            title={song.isLocked ? 'Song lock options' : 'Lock options'}
            id="lock-btn"
          >
            {song.isLocked ? '🔓 Unlocked ▾' : '🔒 Lock ▾'}
          </button>

          {lockMenuOpen && (
            <div className={styles.dropdown} role="menu">
              {passwordPromptMode ? (
                <form className={styles.lockPasswordForm} onSubmit={submitLockPassword}>
                  {!user && (
                    <div className={styles.guestLockWarning}>
                      <span className={styles.warningIcon}>⚠️</span>
                      <p>
                        To encrypt and save your songs permanently, you must sign in or create an account.
                      </p>
                      <div className={styles.guestWarningActions}>
                        <Link to="/login" className={styles.warningLoginBtn} onClick={handleAuthRedirect}>
                          Sign In
                        </Link>
                        <Link to="/signup" className={styles.warningSignupBtn} onClick={handleAuthRedirect}>
                          Create Account
                        </Link>
                      </div>
                    </div>
                  )}
                  <input
                    type="password"
                    placeholder="Password"
                    value={lockPassword}
                    onChange={(e) => setLockPassword(e.target.value)}
                    autoFocus
                    required
                    minLength={8}
                    className={styles.lockPasswordInput}
                    id="lock-password-input"
                    autoComplete="new-password"
                  />
                  <input
                    type="password"
                    placeholder="Confirm password"
                    value={confirmLockPassword}
                    onChange={(e) => setConfirmLockPassword(e.target.value)}
                    required
                    minLength={8}
                    className={styles.lockPasswordInput}
                    id="lock-password-confirm-input"
                    autoComplete="new-password"
                  />
                  {lockError && <div className={styles.lockErrorText}>{lockError}</div>}
                  <button
                    type="submit"
                    className={styles.dropdownItem}
                    disabled={lockSubmitting}
                    id="lock-password-submit-btn"
                  >
                    {lockSubmitting ? 'Saving…' : passwordPromptMode === 'change' ? 'Change password' : 'Set password & lock'}
                  </button>
                </form>
              ) : song.isLocked ? (
                <>
                  <button
                    className={styles.dropdownItem}
                    onClick={() => { relockSong(song.id); setLockMenuOpen(false); }}
                    role="menuitem"
                    id="lock-now-btn"
                  >
                    <span className={styles.dropdownIcon}>🔒</span>
                    Lock song now
                    <span className={styles.dropdownHint}>Revoke session access</span>
                  </button>
                  <button
                    className={styles.dropdownItem}
                    onClick={() => setPasswordPromptMode('change')}
                    role="menuitem"
                    id="lock-change-password-btn"
                  >
                    <span className={styles.dropdownIcon}>🔑</span>
                    Change password
                  </button>
                </>
              ) : (
                <button
                  className={styles.dropdownItem}
                  onClick={() => setPasswordPromptMode('set')}
                  role="menuitem"
                  id="lock-password-protect-btn"
                >
                  <span className={styles.dropdownIcon}>🔐</span>
                  Password-protect…
                  <span className={styles.dropdownHint}>Real encryption</span>
                </button>
              )}
            </div>
          )}
        </div>


        {/* Export dropdown */}
        <div className={styles.exportWrap} ref={exportRef}>
          <button
            className={styles.btn}
            onClick={() => setShowExport((v) => !v)}
            id="export-btn"
            title="Export options"
          >
            ↑ Export
          </button>
          {showExport && (
            <div className={styles.dropdown} role="menu">
              <button
                className={styles.dropdownItem}
                id="export-txt-btn"
                onClick={() => { downloadText(song); setShowExport(false); }}
                role="menuitem"
              >
                <span className={styles.dropdownIcon}>📄</span>
                Export as .txt
                <span className={styles.dropdownHint}>Ultimate Guitar style</span>
              </button>
              <button
                className={styles.dropdownItem}
                id="export-pdf-btn"
                onClick={() => { exportToPdf(); setShowExport(false); }}
                role="menuitem"
              >
                <span className={styles.dropdownIcon}>🖨</span>
                Export as PDF
                <span className={styles.dropdownHint}>via browser print</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
