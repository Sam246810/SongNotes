import { useState, useRef, useEffect } from 'react';
import useSongsStore from '../../store/songsStore';
import { downloadText, exportToPdf } from '../../utils/export';
import styles from './Toolbar.module.css';

export default function Toolbar({ song, sidebarOpen, onToggleSidebar, showScratchpad, onToggleScratchpad }) {
  const { renameSong, toggleLock } = useSongsStore();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(song.title);
  const [showExport, setShowExport] = useState(false);
  const titleRef = useRef(null);
  const exportRef = useRef(null);

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
            onClick={() => { if (!song.locked) setEditingTitle(true); }}
            title={song.locked ? 'Unlock to rename' : 'Click to rename'}
            aria-label="Song title — click to edit"
            id="song-title-btn"
          >
            {song.title}
            {!song.locked && <span className={styles.editIcon}>✎</span>}
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

        {/* Lock / Unlock */}
        <button
          className={`${styles.btn} ${song.locked ? styles.btnWarning : ''}`}
          onClick={() => toggleLock(song.id)}
          title={song.locked ? 'Unlock document' : 'Lock document'}
          id="lock-btn"
        >
          {song.locked ? '🔓 Unlock' : '🔒 Lock'}
        </button>


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
