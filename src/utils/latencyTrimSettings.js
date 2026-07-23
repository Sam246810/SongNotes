const TRIM_KEY = 'songnotes-latency-trim-ms';
const PIANO_TRIM_KEY = 'songnotes-piano-trim-ms';
const SEEN_KEY = 'songnotes-latency-trim-helper-seen';

/**
 * Global (cross-song) latency trim value, in milliseconds.
 * Falls back to the given default the first time nothing has been saved.
 */
export function getStoredLatencyTrimMs(fallback) {
  const raw = localStorage.getItem(TRIM_KEY);
  if (raw === null) return fallback;
  const num = parseInt(raw, 10);
  return Number.isNaN(num) ? fallback : num;
}

export function setStoredLatencyTrimMs(ms) {
  localStorage.setItem(TRIM_KEY, String(ms));
}

/**
 * Global (cross-song) extra trim applied to PIANO takes only, in milliseconds.
 * Piano notes are synthesised in-context with no ADC input latency, so they tend to
 * sit ahead of mic takes; this lets the user nudge piano independently to match.
 */
export function getStoredPianoTrimMs(fallback = 0) {
  const raw = localStorage.getItem(PIANO_TRIM_KEY);
  if (raw === null) return fallback;
  const num = parseInt(raw, 10);
  return Number.isNaN(num) ? fallback : num;
}

export function setStoredPianoTrimMs(ms) {
  localStorage.setItem(PIANO_TRIM_KEY, String(ms));
}

export function hasSeenLatencyTrimHelper() {
  return localStorage.getItem(SEEN_KEY) === 'true';
}

export function markLatencyTrimHelperSeen() {
  localStorage.setItem(SEEN_KEY, 'true');
}
