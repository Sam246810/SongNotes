import { useState } from 'react';
import { Link } from 'react-router-dom';
import useAuth from '../../auth/useAuth';
import styles from './BookLanding.module.css';

export default function BookLanding({ onOpen }) {
  const { user } = useAuth();
  const [opening, setOpening] = useState(false);

  function handleOpenBook() {
    if (opening) return;
    setOpening(true);
    // Smooth, fast opening transition (600ms)
    setTimeout(() => {
      onOpen();
    }, 600);
  }

  return (
    <div className={`${styles.viewport} ${opening ? styles.zoomed : ''}`}>
      <div className={`${styles.book} ${opening ? styles.opened : ''}`}>
        {/* Back Cover */}
        <div className={`${styles.bookPart} ${styles.backCover}`} />

        {/* Interior Page */}
        <div className={styles.pagesStack}>
          <div className={styles.pageContent}>
            <div className={styles.pageTitle}>SongNotes</div>
            <div className={styles.pageSubtitle}>A clean space for chords & lyrics.</div>
          </div>
        </div>

        {/* Front Cover */}
        <div className={`${styles.bookPart} ${styles.frontCover}`}>
          <div className={styles.coverInner}>
            <div className={styles.branding}>
              <div className={styles.logoIcon}>✎</div>
              <h1 className={styles.mainTitle}>SongNotes</h1>
              <p className={styles.tagline}>Chords & Lyrics Journal</p>
            </div>
            
            {user ? (
              <button className={styles.loginBtn} onClick={handleOpenBook}>
                Enter Notebook
              </button>
            ) : (
              <div className={styles.choiceActions}>
                <Link to="/login" className={styles.loginBtn}>
                  Login / Sign Up
                </Link>
                <button className={styles.guestBtn} onClick={handleOpenBook}>
                  Continue as Guest
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      
      <p className={styles.hint}>Please choose an option to enter</p>
    </div>
  );
}
