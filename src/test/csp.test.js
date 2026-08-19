import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Guards the deployment security headers in vercel.json against silent drift.
 *
 * The CSP pins the one inline <script> in index.html (the pre-paint theme setter) by
 * SHA-256 hash rather than allowing 'unsafe-inline'. That is the right trade, but it
 * couples two files that nothing else connects: edit the inline script and the hash
 * stops matching, the browser silently refuses to run it, and the only symptom is a
 * light-mode flash on load for dark-mode users. Nobody would connect that to a CSP
 * header. This test makes the coupling explicit and fails loudly instead.
 *
 * Vite copies the inline script into dist/index.html byte-for-byte (verified when the
 * policy was written), so hashing the source file is equivalent to hashing what is
 * actually served.
 */

// This file is ESM, so there is no __dirname; resolve relative to the module's own URL
// rather than cwd, so the test doesn't depend on where the runner was invoked from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readCsp() {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));
  const headers = vercelConfig.headers?.[0]?.headers ?? [];
  const csp = headers.find((h) => h.key === 'Content-Security-Policy');
  return { vercelConfig, headers, csp };
}

describe('deployment security headers', () => {
  it("pins index.html's inline theme script by hash, and the hash still matches", () => {
    const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
    const inline = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(inline, 'index.html should still contain exactly one inline <script>').not.toBeNull();

    // Newlines MUST be normalized to LF before hashing. The HTML parser normalizes CRLF
    // to LF while building the text node, so the browser hashes LF-only content — but
    // this file is checked out with CRLF on Windows. Hashing the raw bytes produces a
    // digest that matches nothing, and the only symptom in production is that the theme
    // script silently stops running. This exact bug shipped into the first draft of the
    // policy and was caught by loading the built app under the real header, not by a
    // unit test — hence this comment.
    const scriptText = inline[1].replace(/\r\n/g, '\n');
    const digest = crypto.createHash('sha256').update(scriptText, 'utf8').digest('base64');
    const { csp } = readCsp();
    expect(csp, 'vercel.json must set a Content-Security-Policy').toBeDefined();
    expect(
      csp.value,
      `index.html's inline script hashes to sha256-${digest}, which is not in the CSP. ` +
        'If you edited that script, update the script-src hash in vercel.json to match.'
    ).toContain(`'sha256-${digest}'`);
  });

  it('allows what the app actually needs at runtime', () => {
    const { csp } = readCsp();
    // AudioWorklet is loaded from a blob: URL (src/audio/recorderEngine.js) and worklets
    // are governed by script-src, not just worker-src — drop either and recording breaks.
    expect(csp.value).toMatch(/script-src[^;]*blob:/);
    expect(csp.value).toMatch(/worker-src[^;]*blob:/);
    // 17 inline style={{…}} props across the components.
    expect(csp.value).toMatch(/style-src[^;]*'unsafe-inline'/);
    // Supabase REST + auth must stay reachable.
    expect(csp.value).toMatch(/connect-src[^;]*supabase\.co/);
    // Exported audio/text and the recovery-code download use blob: object URLs.
    expect(csp.value).toMatch(/media-src[^;]*blob:/);
  });

  it('locks down the directives that have no legitimate use here', () => {
    const { csp } = readCsp();
    expect(csp.value).toContain("object-src 'none'");
    expect(csp.value).toContain("base-uri 'none'");
    expect(csp.value).toContain("frame-ancestors 'none'");
    expect(csp.value).not.toContain("'unsafe-eval'");
  });

  it('does not block the microphone, which the DAW and latency helper require', () => {
    const { headers } = readCsp();
    const pp = headers.find((h) => h.key === 'Permissions-Policy');
    expect(pp, 'vercel.json must set a Permissions-Policy').toBeDefined();
    // DAWPanel.jsx and LatencyTrimHelper.jsx both call getUserMedia. A well-meaning
    // "lock everything down" edit here would break recording with a confusing error.
    expect(pp.value).not.toMatch(/microphone=\(\)/);
  });

  it('sets the other baseline headers', () => {
    const { headers } = readCsp();
    const byKey = Object.fromEntries(headers.map((h) => [h.key, h.value]));
    expect(byKey['X-Content-Type-Options']).toBe('nosniff');
    expect(byKey['X-Frame-Options']).toBe('DENY');
    expect(byKey['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });
});
