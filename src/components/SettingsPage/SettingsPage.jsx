import { Link } from 'react-router-dom';
import useAuth from '../../auth/useAuth';
import { useTheme, setThemePreference } from '../../utils/theme';
import pageStyles from '../../auth/AuthPage.module.css';
import styles from './SettingsPage.module.css';

const THEME_OPTIONS = [
  { value: 'light', label: '🌅 Warm Light' },
  { value: 'dark', label: '🕯️ Cozy Dark' },
  { value: 'system', label: '💻 Match system' },
];

/**
 * General, device-level settings: open to guests too, unlike AccountPage,
 * which is signed-in only and holds the encryption/password actions.
 */
export default function SettingsPage() {
  const { configured, user } = useAuth();
  const { preference } = useTheme();

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.card}>
        <div className={pageStyles.logo}>
          <span className={pageStyles.logoIcon}>♪</span>
          <span className={pageStyles.logoText}>SongNotes</span>
        </div>
        <h1 className={pageStyles.title}>Settings</h1>

        <section className={styles.group} aria-labelledby="settings-general-heading">
          <h2 className={styles.groupTitle} id="settings-general-heading">General</h2>
          <div className={styles.row}>
            <span className={styles.rowLabel} id="settings-theme-label">Theme</span>
            <div className={styles.segmented} role="radiogroup" aria-labelledby="settings-theme-label">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={preference === opt.value}
                  className={`${styles.segment} ${preference === opt.value ? styles.segmentActive : ''}`}
                  onClick={() => setThemePreference(opt.value)}
                  id={`theme-option-${opt.value}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className={styles.hint}>Saved on this browser only.</p>
          </div>
        </section>

        {configured && user && (
          <Link className={`${pageStyles.guestLink} ${pageStyles.section}`} to="/account">
            Account: recovery code, password…
          </Link>
        )}
        <Link className={pageStyles.guestLink} to="/">← Back to SongNotes</Link>
      </div>
    </div>
  );
}
