const TRIM_KEY = 'songnotes-latency-trim-ms';
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

export function hasSeenLatencyTrimHelper() {
  return localStorage.getItem(SEEN_KEY) === 'true';
}

export function markLatencyTrimHelperSeen() {
  localStorage.setItem(SEEN_KEY, 'true');
}
