import styles from '../../auth/AuthPage.module.css';

/**
 * Shown instead of the whole app to visitors on an actual mobile device (see
 * isMobileDevice.js) — the web app is desktop-only; mobile is served by the
 * native Android app instead. The Play Store link is a placeholder until
 * that app ships.
 */
export default function MobileAppPromo() {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>♪</span>
          <span className={styles.logoText}>SongNotes</span>
        </div>
        <h1 className={styles.title}>Get the SongNotes app</h1>
        <p className={styles.subtitle}>
          SongNotes on mobile lives in our Android app, built for chords &amp; lyrics on
          the go. This web version is designed for desktop screens.
        </p>
        <a className={styles.storeBtn} href="#" id="mobile-play-store-btn">
          ▶ Get it on Google Play
        </a>
        <p className={styles.guestLink}>Launching soon — check back!</p>
      </div>
    </div>
  );
}
