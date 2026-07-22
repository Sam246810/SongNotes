let sharedAudioCtx = null;

/**
 * Returns the shared Web Audio Context singleton.
 */
export function getSharedAudioContext() {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    sharedAudioCtx = new AudioCtx({
      latencyHint: 0.003,
      powerPreference: 'high-performance'
    });
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}
