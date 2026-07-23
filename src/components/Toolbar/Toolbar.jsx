import { useState, useRef, useEffect } from 'react';
import useSongsStore from '../../store/songsStore';
import useAuth from '../../auth/useAuth';
import { downloadText, exportToPdf } from '../../utils/export';
import styles from './Toolbar.module.css';

export default function Toolbar({ song, sidebarOpen, onToggleSidebar, showScratchpad, onToggleScratchpad }) {
  const { renameSong, toggleReadOnly, lockSong } = useSongsStore();
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
    if (song.isReadOnly) {
      toggleReadOnly(song.id); // matches the original single-click toggle behavior
      return;
    }
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
            onClick={() => { if (!song.isReadOnly) setEditingTitle(true); }}
            title={song.isReadOnly ? 'Remove read-only to rename' : 'Click to rename'}
            aria-label="Song title — click to edit"
            id="song-title-btn"
          >
            {song.title}
            {!song.isReadOnly && <span className={styles.editIcon}>✎</span>}
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
            className={`${styles.btn} ${(song.isReadOnly || song.isLocked) ? styles.btnWarning : ''}`}
            onClick={handleLockButtonClick}
            title={song.isReadOnly ? 'Remove read-only' : song.isLocked ? 'Song lock options' : 'Lock options'}
            id="lock-btn"
          >
            {song.isLocked ? '🔒 Locked' : song.isReadOnly ? '🔓 Read-only' : '🔒 Lock ▾'}
          </button>

          {lockMenuOpen && (
            <div className={styles.dropdown} role="menu">
              {passwordPromptMode ? (
                <form className={styles.lockPasswordForm} onSubmit={submitLockPassword}>
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
                <button
                  className={styles.dropdownItem}
                  onClick={() => setPasswordPromptMode('change')}
                  role="menuitem"
                  id="lock-change-password-btn"
                >
                  <span className={styles.dropdownIcon}>🔑</span>
                  Change password
                </button>
              ) : (
                <>
                  <button
                    className={styles.dropdownItem}
                    onClick={() => { toggleReadOnly(song.id); setLockMenuOpen(false); }}
                    role="menuitem"
                    id="lock-readonly-btn"
                  >
                    <span className={styles.dropdownIcon}>🔏</span>
                    Make Read-only
                    <span className={styles.dropdownHint}>Quick toggle, no password</span>
                  </button>
                  {user && (
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
                </>
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
