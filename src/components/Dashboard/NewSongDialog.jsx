import { useState, useRef } from 'react';
import { parseLyricsText } from '../../utils/lyricsImport';
import { extractTextFromPdf } from '../../utils/pdfImport';
import styles from './NewSongDialog.module.css';

/**
 * Shown every time a new song is created, letting the user enter a song title
 * — or, in Import Lyrics mode, paste/upload existing lyrics (optionally with
 * chords already typed above certain lines) to start the song already filled
 * in instead of blank. Detection runs per line and is always meant to be
 * hand-edited afterward like any other pasted text — see lyricsImport.js.
 *
 * Encryption is no longer a per-song choice — signed-in users get every song
 * encrypted automatically, guests never do (see Dashboard.jsx's handleEncryptChoiceDone).
 *
 * @param {(result: {title: string, lines?: Array<{chords: string, lyrics: string}>, meta?: object}) => void} onDone
 * @param {() => void} onCancel
 */
export default function NewSongDialog({ onDone, onCancel }) {
  const [mode, setMode] = useState('blank'); // 'blank' | 'import'
  const [songTitle, setSongTitle] = useState('Untitled Song');
  const [titleTouched, setTitleTouched] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [isReadingFile, setIsReadingFile] = useState(false);
  const fileInputRef = useRef(null);

  function handleTitleChange(e) {
    setSongTitle(e.target.value);
    setTitleTouched(true);
  }

  function applyImportedText(text, fileName) {
    setImportText(text);
    if (!titleTouched) {
      const { title } = parseLyricsText(text);
      if (title) {
        setSongTitle(title);
      } else if (fileName) {
        setSongTitle(fileName.replace(/\.[^./\\]+$/, '') || 'Untitled Song');
      }
    }
  }

  async function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after fixing an error
    if (!file) return;

    setImportError('');
    setIsReadingFile(true);
    try {
      const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
      const text = isPdf ? await extractTextFromPdf(await file.arrayBuffer()) : await file.text();
      if (!text.trim()) {
        setImportError("That file didn't have any readable text in it. Try pasting the lyrics directly instead.");
        return;
      }
      applyImportedText(text, file.name);
    } catch (err) {
      console.error('Failed to read import file:', err);
      setImportError("Couldn't read that file. Try pasting the lyrics directly instead.");
    } finally {
      setIsReadingFile(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    let title = songTitle.trim() || 'Untitled Song';
    if (mode === 'import' && importText.trim()) {
      const { title: detectedTitle, meta, lines } = parseLyricsText(importText);
      // File uploads already auto-fill the title as soon as they're read (see
      // applyImportedText); this catches the equally common case of pasting
      // text straight into the textarea, where the same header format wasn't
      // detected until now.
      if (!titleTouched && detectedTitle) title = detectedTitle;
      onDone({ title, lines, meta });
    } else {
      onDone({ title });
    }
  }

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className={styles.title}>Create New Song</h2>

        <div className={styles.modeTabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'blank'}
            className={`${styles.modeTab} ${mode === 'blank' ? styles.modeTabActive : ''}`}
            onClick={() => setMode('blank')}
            id="new-song-mode-blank"
          >
            Blank Song
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'import'}
            className={`${styles.modeTab} ${mode === 'import' ? styles.modeTabActive : ''}`}
            onClick={() => setMode('import')}
            id="new-song-mode-import"
          >
            Import Lyrics
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.titleInputContainer}>
            <label className={styles.inputLabel} htmlFor="new-song-title">Song Title</label>
            <input
              id="new-song-title"
              type="text"
              className={styles.titleInput}
              value={songTitle}
              onChange={handleTitleChange}
              onFocus={(e) => e.target.select()}
              placeholder="e.g. Yesterday"
              autoFocus={mode === 'blank'}
            />
          </div>

          {mode === 'import' && (
            <div className={styles.importSection}>
              <p className={styles.importHint}>
                Paste lyrics below, or upload a .txt or .pdf file. If chords are already
                typed above certain lines, we'll try to line them up with the lyrics
                beneath automatically — you can always fix them by hand afterward.
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.pdf,text/plain,application/pdf"
                hidden
                onChange={handleFilePicked}
                id="import-lyrics-file-input"
              />
              <button
                type="button"
                className={styles.importFileBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={isReadingFile}
                id="import-lyrics-file-btn"
              >
                {isReadingFile ? 'Reading file…' : '⇩ Upload .txt or .pdf'}
              </button>
              {importError && <p className={styles.importError}>{importError}</p>}

              <textarea
                className={styles.importTextarea}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'G          C          D\nAmazing grace, how sweet the sound...'}
                rows={8}
                id="import-lyrics-textarea"
              />
            </div>
          )}

          <button type="submit" className={styles.createBtn} id="new-song-create-btn">
            {mode === 'import' ? 'Import & Create' : 'Create'}
          </button>
        </form>
        <button className={styles.cancelLink} onClick={onCancel} id="new-song-cancel-btn">
          Cancel
        </button>
      </div>
    </div>
  );
}
