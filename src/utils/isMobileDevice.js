/**
 * Detects an actual mobile OS/browser via user agent — deliberately not a
 * viewport-width check, so resizing a desktop browser window never triggers
 * it, only a real phone (or a browser explicitly impersonating one).
 */
export default function isMobileDevice() {
  if (typeof navigator === 'undefined' || !navigator.userAgent) return false;
  return /Android|iPhone|iPod|iPad|IEMobile|Mobi/i.test(navigator.userAgent);
}
