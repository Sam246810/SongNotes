import styles from './PrivacyPage.module.css';

/**
 * The SongNotes Android app's privacy policy, served at /privacy for its
 * Google Play listing. The source text lives in the Android repo
 * (docs/PRIVACY_POLICY.md, written from that app's code); keep the two in
 * step. Exempt from main.jsx's mobile gate, since Play opens it on phones.
 */
export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <h1>SongNotes Privacy Policy</h1>
        <p className={styles.updated}>Last updated: 31 October 2026</p>

        <p>
          This policy describes what data the SongNotes Android app (&ldquo;the app&rdquo;) collects, how it&rsquo;s
          used, and the choices you have.
        </p>

        <h2>Summary</h2>
        <ul>
          <li>SongNotes works fully offline with no account. Your songs, chords, and recordings stay on your device.</li>
          <li>Creating an account is optional, and used only to sync your songs across your own devices.</li>
          <li>
            Audio you record (Scratchpad takes, calibration tones) <strong>never leaves your device</strong>. It is not
            uploaded anywhere.
          </li>
          <li>
            Song content (lyrics, chords, titles, metadata) is{' '}
            <strong>encrypted on your device before it&rsquo;s sent to our sync backend</strong>. We, and our backend
            provider, cannot read it.
          </li>
          <li>The app does not use analytics, advertising, or tracking SDKs of any kind.</li>
        </ul>

        <h2>What we collect</h2>
        <h3>If you never create an account</h3>
        <p>
          Nothing leaves your device. Songs, chord voicings, recordings, and app settings are stored locally in an
          encrypted database on your phone.
        </p>

        <h3>If you create an account</h3>
        <p>To create an account, we collect:</p>
        <ul>
          <li>
            <strong>Email address and password</strong>, used to authenticate you via our authentication provider,
            Supabase. Your password is never stored or seen by us directly; Supabase handles credential storage and
            verification.
          </li>
        </ul>
        <p>
          Syncing is manual: nothing is uploaded automatically, not even right after you sign in. Your songs stay on
          your device until you tap the Sync button yourself. Once you do, to sync your songs across your devices, we
          store:
        </p>
        <ul>
          <li>
            <strong>Your song content</strong> (lyrics, chords, titles, and details like BPM, key and tuning), but only
            in encrypted form. Your device encrypts this content with a key derived from your account password before
            sending it. Our sync backend stores only the resulting ciphertext; it cannot read your lyrics or chords,
            and neither can we.
          </li>
          <li>
            <strong>Account-level metadata needed to sync correctly</strong>: an internal account identifier, and
            timestamps and version numbers used to resolve edits made to the same song on two devices.
          </li>
        </ul>
        <p>
          We do <strong>not</strong> collect or transmit:
        </p>
        <ul>
          <li>
            Microphone audio. Recordings made in the Scratchpad, and the audio played and captured during calibration,
            are processed and stored entirely on your device and are never uploaded.
          </li>
          <li>Location data.</li>
          <li>Contacts.</li>
          <li>Photos, camera data, or files outside the app&rsquo;s own data.</li>
          <li>Advertising identifiers.</li>
        </ul>

        <h2>Biometric unlock</h2>
        <p>
          If you enable fingerprint or face unlock for account access, your device&rsquo;s biometric sensor confirms
          your identity using Android&rsquo;s own Keystore and BiometricPrompt system.{' '}
          <strong>The app never receives, stores, or transmits your fingerprint or face data</strong>, only a yes/no
          confirmation from the operating system.
        </p>

        <h2>Third-party service providers</h2>
        <p>SongNotes uses one third-party service to provide account and sync functionality:</p>
        <ul>
          <li>
            <strong>Supabase</strong> (authentication and database hosting) processes your email address (for login)
            and the encrypted song data described above. See{' '}
            <a href="https://supabase.com/privacy" target="_blank" rel="noreferrer">
              Supabase&rsquo;s privacy policy
            </a>{' '}
            for how they handle data on their infrastructure.
          </li>
        </ul>
        <p>We do not sell your data, and we do not share it with advertisers or data brokers.</p>

        <h2>Data retention and deletion</h2>
        <p>
          Locally stored data is deleted when you delete the app or clear its storage from your device&rsquo;s app
          settings.
        </p>
        <p>
          To delete your account and all synced data, go to{' '}
          <a href="https://www.songnotes.cloud/delete-account">www.songnotes.cloud/delete-account</a> (also linked from
          the app&rsquo;s Account screen), sign in, and confirm. This permanently deletes your account and every song
          stored with it from our backend. You don&rsquo;t need to contact us to do it.
        </p>

        <h2>Children&rsquo;s privacy</h2>
        <p>
          SongNotes is not directed at children under 13, and we do not knowingly collect personal information from
          children under 13.
        </p>

        <h2>Security</h2>
        <ul>
          <li>Songs and account keys are stored locally using an encrypted database (SQLCipher) and Android&rsquo;s Keystore.</li>
          <li>
            Song content synced to our backend is encrypted on your device before it&rsquo;s sent, using a key derived
            from your account password. The backend never has access to the key or the plaintext content.
          </li>
          <li>All network traffic uses HTTPS/TLS.</li>
        </ul>

        <h2>Changes to this policy</h2>
        <p>
          If this policy changes, we&rsquo;ll update the &ldquo;Last updated&rdquo; date above, and the new version
          applies from that date.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy or your data:{' '}
          <a href="mailto:smths0063@gmail.com">smths0063@gmail.com</a>
        </p>
      </article>
    </main>
  );
}
