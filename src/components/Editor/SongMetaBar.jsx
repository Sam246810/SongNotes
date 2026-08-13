import styles from './SongMetaBar.module.css';

const KEY_OPTIONS = [
  'C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B',
  'Cm', 'C#m', 'Dm', 'D#m', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'A#m', 'Bbm', 'Bm',
];

const TUNING_OPTIONS = [
  'Standard', 'Drop D', 'Half Step Down', 'Full Step Down', 'Open D', 'Open G', 'Open C', 'Open E', 'DADGAD',
];

/**
 * A small reference strip at the top of the lyric sheet — BPM, Key, Guitar
 * Tuning, and Capo position, all optional free-text fields, plus a Transpose
 * control that rewrites every recognized chord in the song by a semitone.
 * Fields are controlled directly off the song object (same pattern as
 * SongLine's chords/lyrics inputs) — there's no local state to go stale when
 * switching songs.
 */
export default function SongMetaBar({ song, onUpdateMeta, onTranspose }) {
  return (
    <div className={styles.metaBar}>
      <div className={styles.metaField}>
        <label className={styles.metaLabel} htmlFor="song-meta-bpm">BPM</label>
        <input
          id="song-meta-bpm"
          className={styles.metaInput}
          type="text"
          inputMode="numeric"
          value={song.bpm || ''}
          onChange={(e) => onUpdateMeta({ bpm: e.target.value })}
          placeholder="—"
        />
      </div>

      <div className={styles.metaField}>
        <label className={styles.metaLabel} htmlFor="song-meta-key">Key</label>
        <input
          id="song-meta-key"
          className={styles.metaInput}
          type="text"
          list="song-meta-key-options"
          value={song.key || ''}
          onChange={(e) => onUpdateMeta({ key: e.target.value })}
          placeholder="—"
        />
        <datalist id="song-meta-key-options">
          {KEY_OPTIONS.map((k) => <option key={k} value={k} />)}
        </datalist>
      </div>

      <div className={styles.metaField}>
        <label className={styles.metaLabel} htmlFor="song-meta-tuning">Tuning</label>
        <input
          id="song-meta-tuning"
          className={styles.metaInput}
          type="text"
          list="song-meta-tuning-options"
          value={song.tuning || ''}
          onChange={(e) => onUpdateMeta({ tuning: e.target.value })}
          placeholder="Standard"
        />
        <datalist id="song-meta-tuning-options">
          {TUNING_OPTIONS.map((t) => <option key={t} value={t} />)}
        </datalist>
      </div>

      <div className={styles.metaField}>
        <label className={styles.metaLabel} htmlFor="song-meta-capo">Capo</label>
        <input
          id="song-meta-capo"
          className={styles.metaInput}
          type="text"
          inputMode="numeric"
          value={song.capo || ''}
          onChange={(e) => onUpdateMeta({ capo: e.target.value })}
          placeholder="—"
        />
      </div>

      <div
        className={styles.transposeGroup}
        title="Transpose every recognized chord in this song up or down a semitone"
      >
        <span className={styles.metaLabel}>Transpose</span>
        <button
          type="button"
          className={styles.transposeBtn}
          onClick={() => onTranspose(-1)}
          aria-label="Transpose down one semitone"
          id="song-transpose-down-btn"
        >
          −
        </button>
        <button
          type="button"
          className={styles.transposeBtn}
          onClick={() => onTranspose(1)}
          aria-label="Transpose up one semitone"
          id="song-transpose-up-btn"
        >
          +
        </button>
      </div>
    </div>
  );
}
